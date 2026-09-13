import FFT from 'fft.js';

export const SAMPLE_RATE = 16000;
export const SEGMENT_SECONDS = 3;
export const SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS;
export const N_FFT = 1024;
export const HOP_LENGTH = 160;
export const N_MELS = 96;
export const N_FRAMES = 301;
export const F_MIN = 50;
export const F_MAX = 7600;

let frontendCache = null;

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
