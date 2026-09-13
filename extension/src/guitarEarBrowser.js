import * as ort from 'onnxruntime-web/wasm';
import {
  SAMPLE_RATE,
  SEGMENT_SECONDS,
  SEGMENT_SAMPLES,
  HOP_LENGTH,
  N_MELS,
  N_FRAMES,
  normalizedLogMel3s,
} from './guitarEarFrontend.js';
import {
  estimatePhase2eRhythmSamples,
  makePhase2eRhythmFeatures,
} from './guitarEarRhythm.js';

const PRESENCE_FRAME_THRESHOLD = 0.35;
const PRESENCE_SEGMENT_THRESHOLD = 0.375;
const PHASE2E_ATTACK_THRESHOLD = 0.50;
const PHASE2D_ATTACK_THRESHOLD = 0.55;
const ATTACK_MIN_PEAK_DISTANCE_MS = 50;

// The acoustic backbone still consumes the frozen 3-second input it was
// calibrated on. Product inference overlaps those windows by 50% and averages
// frame probabilities. Phase-2e adds an aligned 8-channel rhythm tensor to each
// window, derived once from the captured audio without using attack labels.
const WINDOW_STRIDE_SECONDS = SEGMENT_SECONDS / 2;
const WINDOW_STRIDE_SAMPLES = Math.round(SAMPLE_RATE * WINDOW_STRIDE_SECONDS);

const PHASE2E_MODEL_NAME = 'guitar-ear-v0.2e-rhythm-seed29.best.pt';
const PHASE2E_MODEL_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2e-rhythm-core.onnx');
const PHASE2D_MODEL_NAME = 'guitar-ear-v0.2d-hardneg.best.pt';
const PHASE2D_MODEL_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx');
const PHASE2D_MODEL_DATA_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx.data');
const ORT_MJS_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.mjs');
const ORT_WASM_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.wasm');

let sessionPromise = null;

const sigmoid = value => 1 / (1 + Math.exp(-value));

async function createSessionBundle() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: ORT_MJS_URL(),
    wasm: ORT_WASM_URL(),
  };

  try {
    const session = await ort.InferenceSession.create(PHASE2E_MODEL_URL(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    if (!session.inputNames.includes('log_mel') || !session.inputNames.includes('rhythm')) {
      throw new Error(`Unexpected Phase-2e inputs: ${session.inputNames.join(', ')}`);
    }
    return {
      session,
      phase: 'phase2e-rhythm',
      model: PHASE2E_MODEL_NAME,
      fallbackReason: null,
    };
  } catch (phase2eError) {
    console.warn('Phase-2e browser model unavailable; falling back to packaged Phase-2d.', phase2eError);
    const session = await ort.InferenceSession.create(PHASE2D_MODEL_URL(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      externalData: [{
        path: 'guitar-ear-v0.2d-core.onnx.data',
        data: PHASE2D_MODEL_DATA_URL(),
      }],
    });
    return {
      session,
      phase: 'phase2d-fallback',
      model: PHASE2D_MODEL_NAME,
      fallbackReason: phase2eError?.message || String(phase2eError),
    };
  }
}

async function getSessionBundle() {
  if (!sessionPromise) sessionPromise = createSessionBundle();
  return sessionPromise;
}

function peakFrames(probabilities, threshold, minDistanceFrames) {
  if (probabilities.length < 3) return [];
  const candidates = [];
  for (let i = 1; i < probabilities.length - 1; i += 1) {
    if (
      probabilities[i] >= threshold &&
      probabilities[i] >= probabilities[i - 1] &&
      probabilities[i] >= probabilities[i + 1]
    ) candidates.push(i);
  }

  const kept = [];
  for (const index of candidates) {
    if (!kept.length || index - kept[kept.length - 1] >= minDistanceFrames) kept.push(index);
    else if (probabilities[index] > probabilities[kept[kept.length - 1]]) kept[kept.length - 1] = index;
  }
  return kept;
}

function frameActiveIntervals(probabilities, threshold, hopSeconds, duration) {
  const intervals = [];
  let startFrame = null;

  const closeInterval = endFrameExclusive => {
    if (startFrame === null) return;
    const start = Math.max(0, startFrame * hopSeconds);
    const end = Math.min(duration, endFrameExclusive * hopSeconds);
    if (end > start) intervals.push({ start, end });
    startFrame = null;
  };

  for (let frame = 0; frame < probabilities.length; frame += 1) {
    const active = Number(probabilities[frame]) >= threshold;
    if (active && startFrame === null) startFrame = frame;
    if (!active && startFrame !== null) closeInterval(frame);
  }
  closeInterval(probabilities.length);
  return intervals;
}

function compactRhythmEstimate(rhythm) {
  if (!rhythm) return { available: false };
  return {
    available: Boolean(rhythm.available),
    method: rhythm.method || null,
    rawBpm: rhythm.rawBpm ?? null,
    pulseBpm: rhythm.pulseBpm ?? null,
    pulsePeriodSeconds: rhythm.pulsePeriodSeconds ?? null,
    phaseSeconds: rhythm.phaseSeconds ?? null,
    slotSeconds: rhythm.slotSeconds ?? null,
    confidence: rhythm.confidence ?? null,
    autocorrelation: rhythm.autocorrelation ?? null,
  };
}

export async function analyzeGuitarEar(audioBuffer) {
  let selectedModel = PHASE2E_MODEL_NAME;
  let selectedPhase = 'phase2e-rhythm';
  let fallbackReason = null;
  let rhythmEstimate = null;
  let attackThreshold = PHASE2E_ATTACK_THRESHOLD;

  try {
    if (!audioBuffer || audioBuffer.sampleRate !== SAMPLE_RATE || audioBuffer.numberOfChannels < 1) {
      throw new Error(`Guitar Ear requires a mono-capable ${SAMPLE_RATE} Hz AudioBuffer.`);
    }

    const audio = audioBuffer.getChannelData(0);
    const duration = audio.length / SAMPLE_RATE;
    if (!audio.length) throw new Error('Guitar Ear received empty audio.');

    const bundle = await getSessionBundle();
    const { session } = bundle;
    selectedModel = bundle.model;
    selectedPhase = bundle.phase;
    fallbackReason = bundle.fallbackReason;

    if (bundle.phase === 'phase2e-rhythm') {
      rhythmEstimate = estimatePhase2eRhythmSamples(audio, SAMPLE_RATE);
      attackThreshold = rhythmEstimate.available ? PHASE2E_ATTACK_THRESHOLD : PHASE2D_ATTACK_THRESHOLD;
    } else {
      rhythmEstimate = { available: false, method: 'phase2d-model-fallback' };
      attackThreshold = PHASE2D_ATTACK_THRESHOLD;
    }

    const segmentScores = [];
    const hopSeconds = HOP_LENGTH / SAMPLE_RATE;
    const minAttackFrames = Math.max(1, Math.round((ATTACK_MIN_PEAK_DISTANCE_MS / 1000) / hopSeconds));
    const globalFrameCount = Math.max(1, 1 + Math.floor(audio.length / HOP_LENGTH));
    const presenceSums = new Float64Array(globalFrameCount);
    const attackSums = new Float64Array(globalFrameCount);
    const frameCounts = new Uint16Array(globalFrameCount);

    let windowIndex = 0;
    for (let startSample = 0; startSample < audio.length; startSample += WINDOW_STRIDE_SAMPLES) {
      const actualSamples = Math.min(SEGMENT_SAMPLES, audio.length - startSample);
      const chunk = new Float32Array(SEGMENT_SAMPLES);
      chunk.set(audio.subarray(startSample, startSample + actualSamples));

      const logMel = normalizedLogMel3s(chunk);
      const input = new ort.Tensor('float32', logMel, [1, N_MELS, N_FRAMES]);
      let output;
      if (bundle.phase === 'phase2e-rhythm') {
        const rhythm = makePhase2eRhythmFeatures({
          nFrames: N_FRAMES,
          hopSeconds,
          cropStartSeconds: startSample / SAMPLE_RATE,
          slotSeconds: rhythmEstimate.slotSeconds,
          phaseSeconds: rhythmEstimate.phaseSeconds,
          confidence: rhythmEstimate.confidence,
          available: rhythmEstimate.available,
        });
        const rhythmInput = new ort.Tensor('float32', rhythm, [1, N_FRAMES, 8]);
        output = await session.run({ log_mel: input, rhythm: rhythmInput });
      } else {
        output = await session.run({ log_mel: input });
      }

      const presenceLogits = output.presence_logits.data;
      const attackLogits = output.attack_logits.data;
      const isLast = startSample + actualSamples >= audio.length;
      let validFrames = Math.min(N_FRAMES, 1 + Math.floor(actualSamples / HOP_LENGTH));
      if (!isLast && actualSamples === SEGMENT_SAMPLES) validFrames = Math.max(1, validFrames - 1);

      let segmentPresenceSum = 0;
      const globalStartFrame = Math.round(startSample / HOP_LENGTH);
      for (let frame = 0; frame < validFrames; frame += 1) {
        const p = sigmoid(Number(presenceLogits[frame]));
        const a = sigmoid(Number(attackLogits[frame]));
        segmentPresenceSum += p;

        const globalFrame = globalStartFrame + frame;
        if (globalFrame < globalFrameCount) {
          presenceSums[globalFrame] += p;
          attackSums[globalFrame] += a;
          frameCounts[globalFrame] += 1;
        }
      }

      const score = segmentPresenceSum / Math.max(1, validFrames);
      const start = startSample / SAMPLE_RATE;
      const end = Math.min(duration, (startSample + actualSamples) / SAMPLE_RATE);
      segmentScores.push({
        index: windowIndex,
        start,
        end,
        presence: score,
        active: score >= PRESENCE_SEGMENT_THRESHOLD,
      });
      windowIndex += 1;
    }

    const presenceProbabilities = new Float32Array(globalFrameCount);
    const attackProbabilities = new Float32Array(globalFrameCount);
    let presenceSum = 0;
    let presenceCount = 0;
    let activeFrameCount = 0;

    for (let frame = 0; frame < globalFrameCount; frame += 1) {
      const count = frameCounts[frame];
      if (!count) continue;
      const p = presenceSums[frame] / count;
      const a = attackSums[frame] / count;
      presenceProbabilities[frame] = p;
      attackProbabilities[frame] = a;
      presenceSum += p;
      presenceCount += 1;
      if (p >= PRESENCE_FRAME_THRESHOLD) activeFrameCount += 1;
    }

    const activeIntervals = frameActiveIntervals(
      presenceProbabilities,
      PRESENCE_FRAME_THRESHOLD,
      hopSeconds,
      duration,
    );

    const attackTimes = [];
    for (const frame of peakFrames(attackProbabilities, attackThreshold, minAttackFrames)) {
      if (presenceProbabilities[frame] < PRESENCE_FRAME_THRESHOLD) continue;
      const eventTime = frame * hopSeconds;
      if (eventTime <= duration) attackTimes.push(eventTime);
    }

    const activeSegmentCount = segmentScores.filter(item => item.active).length;
    return {
      available: true,
      device: 'browser-wasm',
      model: selectedModel,
      phase: selectedPhase,
      inferenceMode: selectedPhase === 'phase2e-rhythm'
        ? 'overlap-frame-presence-rhythm-conditioned-v1'
        : 'overlap-frame-presence-v1',
      windowStrideSeconds: WINDOW_STRIDE_SECONDS,
      presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
      presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
      attackThreshold,
      phase2eAttackThreshold: PHASE2E_ATTACK_THRESHOLD,
      phase2dFallbackAttackThreshold: PHASE2D_ATTACK_THRESHOLD,
      rhythmConditioning: compactRhythmEstimate(rhythmEstimate),
      modelFallbackReason: fallbackReason,
      meanPresence: presenceCount ? presenceSum / presenceCount : 0,
      activeFraction: activeFrameCount / Math.max(1, presenceCount),
      activeSegmentFraction: activeSegmentCount / Math.max(1, segmentScores.length),
      activeIntervals,
      segmentScores,
      attackTimes,
      attackCount: attackTimes.length,
      durationSeconds: duration,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      device: 'browser-wasm',
      model: selectedModel,
      phase: selectedPhase,
      inferenceMode: selectedPhase === 'phase2e-rhythm'
        ? 'overlap-frame-presence-rhythm-conditioned-v1'
        : 'overlap-frame-presence-v1',
      windowStrideSeconds: WINDOW_STRIDE_SECONDS,
      presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
      presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
      attackThreshold,
      phase2eAttackThreshold: PHASE2E_ATTACK_THRESHOLD,
      phase2dFallbackAttackThreshold: PHASE2D_ATTACK_THRESHOLD,
      rhythmConditioning: compactRhythmEstimate(rhythmEstimate),
      modelFallbackReason: fallbackReason,
      meanPresence: null,
      activeFraction: null,
      activeSegmentFraction: null,
      activeIntervals: [],
      segmentScores: [],
      attackTimes: [],
      attackCount: 0,
      error: error?.message || String(error),
    };
  }
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
});
