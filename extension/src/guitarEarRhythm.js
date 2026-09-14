import FFT from 'fft.js';

export const PHASE2E_RHYTHM_FEATURES = 8;

const N_FFT = 1024;
const HOP = 320;
const MIN_BPM = 60;
const MAX_BPM = 200;
const TWO_PI = Math.PI * 2;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Number(value)));
const roundTo = (value, digits) => Number(Number(value).toFixed(digits));

function roundHalfEven(value) {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileLinear(values, percentile) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  const weight = position - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function populationStd(values) {
  if (!values.length) return 0;
  let mean = 0;
  for (const value of values) mean += value;
  mean /= values.length;
  let variance = 0;
  for (const value of values) {
    const delta = value - mean;
    variance += delta * delta;
  }
  return Math.sqrt(variance / values.length);
}

function normalizePulseBpm(bpm) {
  let value = Number(bpm);
  while (value > 140) value *= 0.5;
  while (value < 70) value *= 2;
  return value;
}

function makeHann(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (size - 1));
  }
  return window;
}

/**
 * Browser reproduction of guitar_ear/rhythm.py::estimate_rhythm_from_waveform.
 * This is intentionally separate from the product tempo-grid analyzer: these
 * values are model inputs, so their numerical contract must match training.
 */
export function estimatePhase2eRhythmSamples(samples, sampleRate, maxSeconds = 45) {
  const method = 'spectral-flux-autocorrelation-v1';
  if (!samples?.length) return { available: false, method };

  const limit = Math.min(samples.length, Math.round(maxSeconds * sampleRate));
  let peak = 0;
  for (let i = 0; i < limit; i += 1) peak = Math.max(peak, Math.abs(Number(samples[i] || 0)));
  if (peak < 1e-5) return { available: false, method };

  const inputLength = Math.max(N_FFT, limit);
  const audio = new Float64Array(inputLength);
  for (let i = 0; i < limit; i += 1) audio[i] = Number(samples[i] || 0) / Math.max(peak, 1e-6);

  const frameCount = 1 + Math.max(0, Math.floor((audio.length - N_FFT) / HOP));
  const flux = new Float64Array(frameCount);
  const fft = new FFT(N_FFT);
  const spectrum = fft.createComplexArray();
  const frame = new Float64Array(N_FFT);
  const window = makeHann(N_FFT);
  const bins = (N_FFT / 2) + 1;
  let previous = null;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * HOP;
    for (let i = 0; i < N_FFT; i += 1) frame[i] = audio[start + i] * window[i];
    fft.realTransform(spectrum, frame);

    const magnitude = new Float64Array(bins);
    let normSquared = 0;
    for (let bin = 0; bin < bins; bin += 1) {
      const re = spectrum[2 * bin] || 0;
      const im = spectrum[(2 * bin) + 1] || 0;
      const value = Math.hypot(re, im);
      magnitude[bin] = value;
      normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared);
    if (norm > 1e-8) {
      for (let bin = 0; bin < bins; bin += 1) magnitude[bin] /= norm;
    }

    if (previous) {
      let positiveFlux = 0;
      for (let bin = 0; bin < bins; bin += 1) {
        const diff = magnitude[bin] - previous[bin];
        if (diff > 0) positiveFlux += diff;
      }
      flux[frameIndex] = positiveFlux;
    }
    previous = magnitude;
  }

  if (flux.length < 32 || populationStd(flux) < 1e-6) return { available: false, method };

  const floor = median(flux);
  const envelope = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i += 1) envelope[i] = Math.max(flux[i] - floor, 0);
  const scale = percentileLinear(envelope, 0.95);
  if (scale <= 1e-8) return { available: false, method };
  for (let i = 0; i < envelope.length; i += 1) envelope[i] = clamp(envelope[i] / scale, 0, 3);

  let envelopeMean = 0;
  for (const value of envelope) envelopeMean += value;
  envelopeMean /= envelope.length;
  const centered = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i += 1) centered[i] = envelope[i] - envelopeMean;

  const frameRate = sampleRate / HOP;
  const minLag = Math.max(1, roundHalfEven((frameRate * 60) / MAX_BPM));
  const maxLag = Math.min(envelope.length - 2, roundHalfEven((frameRate * 60) / MIN_BPM));
  let bestLag = null;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let i = 0; i < centered.length - lag; i += 1) {
      const left = centered[i];
      const right = centered[i + lag];
      dot += left * right;
      leftNorm += left * left;
      rightNorm += right * right;
    }
    const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
    const score = denom > 1e-9 ? dot / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === null) return { available: false, method };

  const rawBpm = (60 * frameRate) / bestLag;
  const pulseBpm = normalizePulseBpm(rawBpm);
  const pulsePeriod = 60 / pulseBpm;
  const periodFrames = pulsePeriod * frameRate;
  const phaseCount = Math.max(1, roundHalfEven(periodFrames));
  let bestPhase = 0;
  let bestPhaseScore = -1;

  for (let offset = 0; offset < phaseCount; offset += 1) {
    let cursor = offset;
    let sum = 0;
    let count = 0;
    while (cursor < envelope.length) {
      const index = roundHalfEven(cursor);
      const lo = Math.max(0, index - 1);
      const hi = Math.min(envelope.length, index + 2);
      if (lo < hi) {
        let localPeak = -Infinity;
        for (let j = lo; j < hi; j += 1) localPeak = Math.max(localPeak, envelope[j]);
        sum += localPeak;
        count += 1;
      }
      cursor += periodFrames;
    }
    const score = count ? sum / count : 0;
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = offset;
    }
  }

  const confidence = clamp((bestScore - 0.05) / 0.45, 0, 1);
  const phaseSeconds = bestPhase / frameRate;
  const slotSeconds = pulsePeriod / 2;

  return {
    available: true,
    method,
    rawBpm: roundTo(rawBpm, 4),
    pulseBpm: roundTo(pulseBpm, 4),
    pulsePeriodSeconds: roundTo(pulsePeriod, 7),
    phaseSeconds: roundTo(phaseSeconds, 7),
    slotSeconds: roundTo(slotSeconds, 7),
    confidence: roundTo(confidence, 6),
    autocorrelation: roundTo(bestScore, 6),
  };
}

/** Browser reproduction of guitar_ear/rhythm.py::make_rhythm_features at inference. */
export function makePhase2eRhythmFeatures({
  nFrames,
  hopSeconds,
  cropStartSeconds,
  slotSeconds,
  phaseSeconds,
  confidence,
  available,
}) {
  const features = new Float32Array(nFrames * PHASE2E_RHYTHM_FEATURES);
  if (!available || !slotSeconds || slotSeconds <= 1e-4 || phaseSeconds === null || phaseSeconds === undefined) {
    return features;
  }

  const slot = Number(slotSeconds);
  const phase = Number(phaseSeconds);
  const conf = clamp(confidence || 0, 0, 1);
  const pulse = slot * 2;
  const slotRateBpm = 60 / slot;
  const tempoNorm = clamp(Math.log2(Math.max(slotRateBpm, 1e-6) / 120) / 2, -1, 1);

  for (let frame = 0; frame < nFrames; frame += 1) {
    // np.arange(..., dtype=float32) followed by float multiplication is most
    // closely reproduced by rounding the frame offset to float32 first.
    const frameOffset = Math.fround(Math.fround(frame) * Math.fround(hopSeconds));
    const time = Number(cropStartSeconds) + frameOffset;
    const pulseRaw = (time - phase) / pulse;
    const slotRaw = (time - phase) / slot;
    const pulseFrac = ((pulseRaw % 1) + 1) % 1;
    const slotFrac = ((slotRaw % 1) + 1) % 1;
    const distance = Math.min(slotFrac, 1 - slotFrac) * 2;
    const offset = frame * PHASE2E_RHYTHM_FEATURES;
    features[offset] = Math.sin(TWO_PI * pulseFrac);
    features[offset + 1] = Math.cos(TWO_PI * pulseFrac);
    features[offset + 2] = Math.sin(TWO_PI * slotFrac);
    features[offset + 3] = Math.cos(TWO_PI * slotFrac);
    features[offset + 4] = 1 - distance;
    features[offset + 5] = tempoNorm;
    features[offset + 6] = conf;
    features[offset + 7] = 1;
  }

  return features;
}
