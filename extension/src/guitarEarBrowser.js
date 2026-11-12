import * as ort from 'onnxruntime-web/wasm';
import {
  SAMPLE_RATE,
  SEGMENT_SECONDS,
  SEGMENT_SAMPLES,
  N_FRAMES,
} from './guitarEarFrontend.js';
import {
  PRESENCE_FRAME_THRESHOLD,
  PRESENCE_SEGMENT_THRESHOLD,
  PHASE2E_ATTACK_THRESHOLD,
  PHASE2D_ATTACK_THRESHOLD,
  WINDOW_STRIDE_SECONDS,
  PHASE2E_MODEL_NAME,
  PHASE2D_MODEL_NAME,
  analyzeGuitarEarSamples,
} from './guitarEarCore.js';

// Browser adapter for Guitar Ear: loads onnxruntime-web (WASM) and the packaged model
// files through chrome.runtime.getURL, then delegates the inference itself (windowing,
// tensors, thresholds, peak picking, summaries) to src/guitarEarCore.js, which the Node
// CLI (tools/transcribe.mjs) shares.

// Controls whether the Phase-2e model load is attempted at all. Keep false until
// dist/models/guitar-ear-v0.2e-rhythm-core.onnx is shipped (checked by validate-v054.mjs).
export const PHASE2E_ENABLED = false;
const PHASE2E_MODEL_SHA256 = '3c900167abcf4157f4e9acee1bdf85f9c870c64fd454d14d67297f2523681911';
const PHASE2E_MODEL_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2e-rhythm-core.onnx');
const PHASE2D_MODEL_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx');
const PHASE2D_MODEL_DATA_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx.data');
const ORT_MJS_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.mjs');
const ORT_WASM_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.wasm');

let sessionPromise = null;

const sigmoid = value => 1 / (1 + Math.exp(-value));

function errorMessage(error) {
  return error?.message || String(error);
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function fetchVerifiedPhase2eModel() {
  const response = await fetch(PHASE2E_MODEL_URL(), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Phase-2e model fetch failed: HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error('Phase-2e model fetch returned an empty file.');
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== PHASE2E_MODEL_SHA256) {
    throw new Error(`Phase-2e model SHA mismatch: expected ${PHASE2E_MODEL_SHA256}, got ${sha256}.`);
  }
  return { bytes, sha256 };
}

async function createPhase2eSession() {
  const { bytes, sha256 } = await fetchVerifiedPhase2eModel();
  const failures = [];
  for (const graphOptimizationLevel of ['all', 'basic', 'disabled']) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel,
      });
      if (!session.inputNames.includes('log_mel') || !session.inputNames.includes('rhythm')) {
        throw new Error(`Unexpected Phase-2e inputs: ${session.inputNames.join(', ')}`);
      }
      return { session, sha256, graphOptimizationLevel };
    } catch (error) {
      failures.push(`${graphOptimizationLevel}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`Phase-2e ONNX/WASM session failed after verified model load. ${failures.join(' | ')}`);
}

async function createSessionBundle() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: ORT_MJS_URL(),
    wasm: ORT_WASM_URL(),
  };

  const createPhase2dSession = () => ort.InferenceSession.create(PHASE2D_MODEL_URL(), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [{
      path: 'guitar-ear-v0.2d-core.onnx.data',
      data: PHASE2D_MODEL_DATA_URL(),
    }],
  });

  // v0.5.3 stable product baseline: keep the proven Phase-2d acoustic model.
  // PHASE2E_ENABLED controls this: while false, Phase-2e is not attempted so
  // stroke-density is the only musical variable. Phase-2e remains in source
  // for later A/B work.
  if (!PHASE2E_ENABLED) {
    const session = await createPhase2dSession();
    return {
      session,
      phase: 'phase2d-stable',
      model: PHASE2D_MODEL_NAME,
      modelSha256: null,
      graphOptimizationLevel: 'all',
      fallbackReason: null,
    };
  }

  try {
    const phase2e = await createPhase2eSession();
    return {
      session: phase2e.session,
      phase: 'phase2e-rhythm',
      model: PHASE2E_MODEL_NAME,
      modelSha256: phase2e.sha256,
      graphOptimizationLevel: phase2e.graphOptimizationLevel,
      fallbackReason: null,
    };
  } catch (phase2eError) {
    console.warn('Phase-2e browser model unavailable; falling back to packaged Phase-2d.', phase2eError);
    const session = await createPhase2dSession();
    return {
      session,
      phase: 'phase2d-fallback',
      model: PHASE2D_MODEL_NAME,
      modelSha256: null,
      graphOptimizationLevel: 'all',
      fallbackReason: errorMessage(phase2eError),
    };
  }
}

async function getSessionBundle() {
  if (!sessionPromise) sessionPromise = createSessionBundle();
  return sessionPromise;
}

export async function analyzeGuitarEar(audioBuffer) {
  // Same input check as before the split; an unusable buffer becomes the core's error result.
  const unusable = !audioBuffer || audioBuffer.sampleRate !== SAMPLE_RATE || audioBuffer.numberOfChannels < 1;
  return analyzeGuitarEarSamples({
    ort,
    getSessionBundle,
    samples: unusable ? null : audioBuffer.getChannelData(0),
    sampleRate: unusable ? null : audioBuffer.sampleRate,
    device: 'browser-wasm',
    inputDescription: `mono-capable ${SAMPLE_RATE} Hz AudioBuffer`,
  });
}

export { normalizedLogMel3s } from './guitarEarFrontend.js';

export const guitarEarBrowserConfig = Object.freeze({
  sampleRate: SAMPLE_RATE,
  segmentSeconds: SEGMENT_SECONDS,
  segmentSamples: SEGMENT_SAMPLES,
  windowStrideSeconds: WINDOW_STRIDE_SECONDS,
  frames: N_FRAMES,
  rhythmFeatures: 8,
  presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
  presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
  phase2eAttackThreshold: PHASE2E_ATTACK_THRESHOLD,
  phase2dFallbackAttackThreshold: PHASE2D_ATTACK_THRESHOLD,
  phase2eModelSha256: PHASE2E_MODEL_SHA256,
});
