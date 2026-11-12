// Basic Pitch in plain Node: the same `BasicPitch` class the extension uses
// (src/offscreen-phase2d.js, runBasicPitch), with the model loaded from disk.
//
// TensorFlow.js in plain Node cannot fetch file:// URLs, so the graph model is loaded
// through an IOHandler built here from model.json and its weight shards. The TF.js module
// is resolved from @spotify/basic-pitch's own location so that the model is created by the
// same TF.js copy that BasicPitch uses for its tensor ops.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASIC_PITCH_MODEL_JSON = path.join(EXTENSION_DIR, 'node_modules', '@spotify', 'basic-pitch', 'model', 'model.json');
const BASIC_PITCH_SAMPLE_RATE = 22050;

async function importTfjs() {
  const attempts = [];
  // 1. The copy @spotify/basic-pitch itself resolves (it depends on @tensorflow/tfjs).
  try {
    const basicPitchEntry = import.meta.resolve('@spotify/basic-pitch');
    const fromBasicPitch = createRequire(basicPitchEntry);
    const tfPath = fromBasicPitch.resolve('@tensorflow/tfjs');
    return { tf: await import(pathToFileURL(tfPath).href), resolvedFrom: tfPath };
  } catch (error) {
    attempts.push(`via @spotify/basic-pitch: ${error?.message || error}`);
  }
  // 2. Whatever resolves from extension/ (hoisted install).
  try {
    const fromExtension = createRequire(path.join(EXTENSION_DIR, 'package.json'));
    const tfPath = fromExtension.resolve('@tensorflow/tfjs');
    return { tf: await import(pathToFileURL(tfPath).href), resolvedFrom: tfPath };
  } catch (error) {
    attempts.push(`from extension/: ${error?.message || error}`);
  }
  throw new Error(`Cannot load @tensorflow/tfjs (a dependency of @spotify/basic-pitch). Run npm install in extension/. ${attempts.join(' | ')}`);
}

// A CommonJS module imported from ESM exposes its exports on `default` (and, when Node can
// detect them statically, also as named exports). Accept either shape.
function tfNamespace(mod) {
  if (mod && typeof mod.loadGraphModel === 'function') return mod;
  if (mod?.default && typeof mod.default.loadGraphModel === 'function') return mod.default;
  throw new Error('@tensorflow/tfjs loaded but exposes no loadGraphModel()');
}

function concatArrayBuffers(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

/** TF.js IOHandler that serves a converted graph model (model.json + shards) from disk. */
export function fileGraphModelHandler(modelJsonPath) {
  return {
    async load() {
      const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
      if (!modelJson.modelTopology) throw new Error(`${modelJsonPath} has no modelTopology`);
      const artifacts = {
        modelTopology: modelJson.modelTopology,
        format: modelJson.format,
        generatedBy: modelJson.generatedBy,
        convertedBy: modelJson.convertedBy,
      };
      if (modelJson.signature != null) artifacts.signature = modelJson.signature;
      if (modelJson.userDefinedMetadata != null) artifacts.userDefinedMetadata = modelJson.userDefinedMetadata;
      if (modelJson.modelInitializer != null) artifacts.modelInitializer = modelJson.modelInitializer;
      if (modelJson.initializerSignature != null) artifacts.initializerSignature = modelJson.initializerSignature;
      if (modelJson.trainingConfig != null) artifacts.trainingConfig = modelJson.trainingConfig;

      const weightSpecs = [];
      const shards = [];
      const dir = path.dirname(modelJsonPath);
      for (const group of modelJson.weightsManifest || []) {
        weightSpecs.push(...group.weights);
        for (const shardPath of group.paths) {
          const file = fs.readFileSync(path.join(dir, shardPath));
          shards.push(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
        }
      }
      artifacts.weightSpecs = weightSpecs;
      artifacts.weightData = concatArrayBuffers(shards);
      return artifacts;
    },
  };
}

// Minimal stand-in for the Web Audio AudioBuffer, so evaluateModel() receives the same kind
// of object it gets in Chrome whichever input check it performs.
class NodeAudioBuffer {
  constructor(samples, sampleRate) {
    this._samples = samples;
    this.sampleRate = sampleRate;
    this.length = samples.length;
    this.duration = samples.length / sampleRate;
    this.numberOfChannels = 1;
  }

  getChannelData(channel) {
    if (channel !== 0) throw new RangeError(`channel ${channel} out of range`);
    return this._samples;
  }
}

/**
 * Run Basic Pitch on mono 22050 Hz samples with the extension's decode settings.
 * @param {Float32Array} samples
 * @param {number} sampleRate  must be 22050
 * @param {{ onProgress?: (fraction: number) => void, log?: (message: string) => void }} [hooks]
 * @returns {Promise<{ frames: number[][], onsets: number[][], contours: number[][] }>}
 */
export async function runBasicPitchNode(samples, sampleRate, { onProgress, log } = {}) {
  if (sampleRate !== BASIC_PITCH_SAMPLE_RATE) throw new Error(`Basic Pitch needs ${BASIC_PITCH_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
  if (!fs.existsSync(BASIC_PITCH_MODEL_JSON)) {
    throw new Error(`Basic Pitch model not found at ${BASIC_PITCH_MODEL_JSON}. Run npm install in extension/.`);
  }

  const { tf: tfModule, resolvedFrom } = await importTfjs();
  const tf = tfNamespace(tfModule);
  log?.(`TensorFlow.js ${tf.version?.tfjs || tf.version_core || '(unknown version)'} from ${resolvedFrom}`);
  // Plain Node has no WebGL; use the pure-JS CPU backend explicitly.
  await tf.setBackend('cpu');
  await tf.ready();

  const { BasicPitch } = await import('@spotify/basic-pitch');
  if (typeof BasicPitch !== 'function') throw new Error('@spotify/basic-pitch does not export a BasicPitch class');

  // BasicPitch's constructor takes a model URL or a Promise<GraphModel>.
  const modelPromise = tf.loadGraphModel(fileGraphModelHandler(BASIC_PITCH_MODEL_JSON));
  const basicPitch = new BasicPitch(modelPromise);

  if (globalThis.AudioBuffer === undefined) globalThis.AudioBuffer = NodeAudioBuffer;
  const audioBuffer = new NodeAudioBuffer(samples, sampleRate);

  const frames = [];
  const onsets = [];
  const contours = [];
  // Same callbacks as runBasicPitch() in src/offscreen-phase2d.js.
  await basicPitch.evaluateModel(
    audioBuffer,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    progress => { onProgress?.(progress); }
  );

  if (!frames.length) throw new Error('Basic Pitch returned no frames');
  return { frames, onsets, contours };
}
