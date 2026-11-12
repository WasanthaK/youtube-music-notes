// Guitar Ear in plain Node: onnxruntime-node + the packaged Phase-2d model from
// public/models, with the inference itself done by the shared src/guitarEarCore.js
// (the same code the extension runs through src/guitarEarBrowser.js).
//
// The session bundle mirrors the browser's stable configuration (PHASE2E_ENABLED = false in
// src/guitarEarBrowser.js): Phase-2d model, phase 'phase2d-stable', graph optimisation 'all'.
// The Node CLI always uses that configuration; it does not read PHASE2E_ENABLED, because
// importing src/guitarEarBrowser.js would pull in onnxruntime-web and chrome.* code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGuitarEarSamples, PHASE2D_MODEL_NAME } from '../../src/guitarEarCore.js';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GUITAR_EAR_MODEL_PATH = path.join(EXTENSION_DIR, 'public', 'models', 'guitar-ear-v0.2d-core.onnx');
const GUITAR_EAR_MODEL_DATA_PATH = `${GUITAR_EAR_MODEL_PATH}.data`;

export const NODE_GUITAR_EAR_DEVICE = 'node-cpu';

let ortPromise = null;
let sessionPromise = null;

async function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-node')
      .then(mod => (mod?.InferenceSession ? mod : mod?.default))
      .then(ort => {
        if (!ort?.InferenceSession || !ort?.Tensor) throw new Error('onnxruntime-node loaded but has no InferenceSession/Tensor');
        return ort;
      })
      .catch(error => {
        throw new Error(`Cannot load onnxruntime-node (devDependency; run npm install in extension/): ${error?.message || error}`);
      });
  }
  return ortPromise;
}

async function createSessionBundle(ort) {
  for (const file of [GUITAR_EAR_MODEL_PATH, GUITAR_EAR_MODEL_DATA_PATH]) {
    if (!fs.existsSync(file)) throw new Error(`Guitar Ear model file missing: ${file}`);
  }
  // Created from the file path so ONNX Runtime finds the external weights file
  // (guitar-ear-v0.2d-core.onnx.data) beside the model.
  const session = await ort.InferenceSession.create(GUITAR_EAR_MODEL_PATH, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  return {
    session,
    phase: 'phase2d-stable',
    model: PHASE2D_MODEL_NAME,
    modelSha256: null,
    graphOptimizationLevel: 'all',
    fallbackReason: null,
  };
}

/**
 * Run Guitar Ear on mono 16 kHz samples. Never throws; failures come back as
 * { available: false, error } exactly like the browser adapter.
 * @param {Float32Array} samples
 * @param {number} sampleRate  must be 16000
 */
export async function analyzeGuitarEarNode(samples, sampleRate) {
  let ort = null;
  try {
    ort = await loadOrt();
  } catch (error) {
    // Let the core build the standard error result.
    return analyzeGuitarEarSamples({
      ort: null,
      getSessionBundle: async () => { throw error; },
      samples,
      sampleRate,
      device: NODE_GUITAR_EAR_DEVICE,
    });
  }
  return analyzeGuitarEarSamples({
    ort,
    getSessionBundle: () => {
      if (!sessionPromise) sessionPromise = createSessionBundle(ort);
      return sessionPromise;
    },
    samples,
    sampleRate,
    device: NODE_GUITAR_EAR_DEVICE,
  });
}
