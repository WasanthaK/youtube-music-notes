import FFT from 'fft.js';
import * as ort from 'onnxruntime-web/wasm';

const SAMPLE_RATE = 16000;
const SEGMENT_SECONDS = 3;
const SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS;
const N_FFT = 1024;
const HOP_LENGTH = 160;
const N_MELS = 96;
const N_FRAMES = 301;
const F_MIN = 50;
const F_MAX = 7600;
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
let frontendCache = null;

const sigmoid = value => 1 / (1 + Math.exp(-value));

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function reflectIndex(index, length) {
  let i = index;
  while (i < 0 || i >= length) {
    if (i < 0) i = -i;
    else i = (2 * length) - 2 - i;
  }
  return i;
}

function buildFrontend() {
  if (frontendCache) return frontendCache;

  const window = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n += 1) {
    window[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / N_FFT));
  }

  const melMin = hzToMel(F_MIN);
  const melMax = hzToMel(F_MAX);
  const hzPoints = new Float64Array(N_MELS + 2);
  for (let i = 0; i < hzPoints.length; i += 1) {
    const mel = melMin + ((melMax - melMin) * i) / (hzPoints.length - 1);
    hzPoints[i] = melToHz(mel);
  }

  const filters = [];
  for (let m = 0; m < N_MELS; m += 1) {
    const left = hzPoints[m];
    const center = hzPoints[m + 1];
    const right = hzPoints[m + 2];
    const bins = [];
    for (let k = 0; k <= N_FFT / 2; k += 1) {
      const hz = (SAMPLE_RATE / 2) * k / (N_FFT / 2);
      const up = (hz - left) / Math.max(center - left, 1e-9);
      const down = (right - hz) / Math.max(right - center, 1e-9);
      const weight = Math.max(0, Math.min(up, down));
      if (weight > 0) bins.push([k, weight]);
    }
    filters.push(bins);
  }

  frontendCache = { window, filters, fft: new FFT(N_FFT) };
  return frontendCache;
}

export function normalizedLogMel3s(waveform) {
  if (!(waveform instanceof Float32Array) || waveform.length !== SEGMENT_SAMPLES) {
    throw new Error(`Guitar Ear frontend expects Float32Array(${SEGMENT_SAMPLES}).`);
  }

  const { window, filters, fft } = buildFrontend();
  const frameInput = new Float64Array(N_FFT);
  const spectrum = fft.createComplexArray();
  const power = new Float64Array((N_FFT / 2) + 1);
  const logMel = new Float32Array(N_MELS * N_FRAMES);

  for (let frame = 0; frame < N_FRAMES; frame += 1) {
    const centerSample = frame * HOP_LENGTH;
    for (let n = 0; n < N_FFT; n += 1) {
      const sourceIndex = reflectIndex(centerSample + n - (N_FFT / 2), waveform.length);
      frameInput[n] = waveform[sourceIndex] * window[n];
    }

    fft.realTransform(spectrum, frameInput);
    for (let k = 0; k < power.length; k += 1) {
      const real = spectrum[2 * k];
      const imag = spectrum[(2 * k) + 1];
      power[k] = (real * real) + (imag * imag);
    }

    for (let mel = 0; mel < N_MELS; mel += 1) {
      let value = 0;
      for (const [bin, weight] of filters[mel]) value += weight * power[bin];
      logMel[(mel * N_FRAMES) + frame] = Math.log1p(value);
    }
  }

  let sum = 0;
  for (const value of logMel) sum += value;
  const mean = sum / logMel.length;

  let squared = 0;
  for (const value of logMel) {
    const delta = value - mean;
    squared += delta * delta;
  }
  const std = Math.max(Math.sqrt(squared / Math.max(1, logMel.length - 1)), 1e-5);
  for (let i = 0; i < logMel.length; i += 1) logMel[i] = (logMel[i] - mean) / std;

  return logMel;
}

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

      const presence = new Float32Array(validFrames);
      const attacks = new Float32Array(validFrames);
      let segmentPresenceSum = 0;
      for (let frame = 0; frame < validFrames; frame += 1) {
        const p = sigmoid(Number(presenceLogits[frame]));
        const a = sigmoid(Number(attackLogits[frame]));
        presence[frame] = p;
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

export const guitarEarBrowserConfig = Object.freeze({
  sampleRate: SAMPLE_RATE,
  segmentSeconds: SEGMENT_SECONDS,
  segmentSamples: SEGMENT_SAMPLES,
  frames: N_FRAMES,
  presenceFrameThreshold: PRESENCE_FRAME_THRESHOLD,
  presenceSegmentThreshold: PRESENCE_SEGMENT_THRESHOLD,
  attackThreshold: ATTACK_THRESHOLD,
});
