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

const PRESENCE_FRAME_THRESHOLD = 0.35;
const PRESENCE_SEGMENT_THRESHOLD = 0.375;
const ATTACK_THRESHOLD = 0.55;
const ATTACK_MIN_PEAK_DISTANCE_MS = 50;

const MODEL_NAME = 'guitar-ear-v0.2d-hardneg.best.pt';
const MODEL_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx');
const MODEL_DATA_URL = () => chrome.runtime.getURL('dist/models/guitar-ear-v0.2d-core.onnx.data');
const ORT_MJS_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.mjs');
const ORT_WASM_URL = () => chrome.runtime.getURL('dist/ort/ort-wasm-simd-threaded.wasm');

let sessionPromise = null;

const sigmoid = value => 1 / (1 + Math.exp(-value));

async function getSession() {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {
      mjs: ORT_MJS_URL(),
      wasm: ORT_WASM_URL(),
    };

    sessionPromise = ort.InferenceSession.create(MODEL_URL(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      externalData: [{
        path: 'guitar-ear-v0.2d-core.onnx.data',
        data: MODEL_DATA_URL(),
      }],
    });
  }
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

export async function analyzeGuitarEar(audioBuffer) {
  try {
    if (!audioBuffer || audioBuffer.sampleRate !== SAMPLE_RATE || audioBuffer.numberOfChannels < 1) {
      throw new Error(`Guitar Ear requires a mono-capable ${SAMPLE_RATE} Hz AudioBuffer.`);
    }

    const audio = audioBuffer.getChannelData(0);
    const duration = audio.length / SAMPLE_RATE;
    if (!audio.length) throw new Error('Guitar Ear received empty audio.');

    const session = await getSession();
    const segmentScores = [];
    const activeIntervals = [];
    const attackTimes = [];
    const hopSeconds = HOP_LENGTH / SAMPLE_RATE;
    const minAttackFrames = Math.max(1, Math.round((ATTACK_MIN_PEAK_DISTANCE_MS / 1000) / hopSeconds));
    let presenceSum = 0;
    let presenceCount = 0;

    const segmentCount = Math.ceil(audio.length / SEGMENT_SAMPLES);
    for (let index = 0; index < segmentCount; index += 1) {
      const startSample = index * SEGMENT_SAMPLES;
      const actualSamples = Math.min(SEGMENT_SAMPLES, audio.length - startSample);
      const chunk = new Float32Array(SEGMENT_SAMPLES);
      chunk.set(audio.subarray(startSample, startSample + actualSamples));

      const logMel = normalizedLogMel3s(chunk);
      const input = new ort.Tensor('float32', logMel, [1, N_MELS, N_FRAMES]);
      const output = await session.run({ log_mel: input });
      const presenceLogits = output.presence_logits.data;
      const attackLogits = output.attack_logits.data;
      const isLast = index === segmentCount - 1;
      let validFrames = Math.min(N_FRAMES, 1 + Math.floor(actualSamples / HOP_LENGTH));
      if (!isLast) validFrames = Math.max(1, validFrames - 1);

      const attacks = new Float32Array(validFrames);
      let segmentPresenceSum = 0;
      for (let frame = 0; frame < validFrames; frame += 1) {
        const p = sigmoid(Number(presenceLogits[frame]));
        const a = sigmoid(Number(attackLogits[frame]));
        attacks[frame] = a;
        segmentPresenceSum += p;
        presenceSum += p;
        presenceCount += 1;
      }

      const score = segmentPresenceSum / Math.max(1, validFrames);
      const active = score >= PRESENCE_SEGMENT_THRESHOLD;
      const start = startSample / SAMPLE_RATE;
      const end = Math.min(duration, (startSample + actualSamples) / SAMPLE_RATE);
      segmentScores.push({ start, end, presence: score, active });

      if (active) {
        const previous = activeIntervals[activeIntervals.length - 1];
        if (previous && start <= previous.end + 0.02) previous.end = end;
        else activeIntervals.push({ start, end });

        for (const frame of peakFrames(attacks, ATTACK_THRESHOLD, minAttackFrames)) {
          const eventTime = start + (frame * hopSeconds);
          if (eventTime <= duration) attackTimes.push(eventTime);
        }
      }
    }

    const activeSeconds = activeIntervals.reduce((sum, interval) => sum + Math.max(0, interval.end - interval.start), 0);
    return {
      available: true,
      device: 'browser-wasm',
      model: MODEL_NAME,
      presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
      presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
      attackThreshold: ATTACK_THRESHOLD,
      meanPresence: presenceCount ? presenceSum / presenceCount : 0,
      activeFraction: activeSeconds / Math.max(duration, 1e-9),
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
      model: MODEL_NAME,
      presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
      presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
      attackThreshold: ATTACK_THRESHOLD,
      meanPresence: null,
      activeFraction: null,
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
  frames: N_FRAMES,
  presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
  presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
  attackThreshold: ATTACK_THRESHOLD,
});
