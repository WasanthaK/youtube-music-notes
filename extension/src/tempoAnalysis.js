import FFT from 'fft.js';

const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const BPM_MIN = 60;
const BPM_MAX = 200;
const LOCAL_MEAN_SECONDS = 0.5;
const PHASE_SEARCH_RADIUS_FRAMES = 2;

const clamp01 = value => Math.max(0, Math.min(1, Number(value)));

function median(values) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function movingAverage(values, radiusFrames) {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const lo = Math.max(0, i - radiusFrames);
    const hi = Math.min(values.length, i + radiusFrames + 1);
    out[i] = (prefix[hi] - prefix[lo]) / Math.max(1, hi - lo);
  }
  return out;
}

function buildOnsetEnvelope(samples, sampleRate) {
  if (!samples?.length || samples.length < FRAME_SIZE) return { envelope: new Float64Array(0), framesPerSecond: sampleRate / HOP_SIZE };

  const fft = new FFT(FRAME_SIZE);
  const fftOut = fft.createComplexArray();
  const frame = new Float64Array(FRAME_SIZE);
  const window = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FRAME_SIZE));

  const frameCount = 1 + Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE);
  const flux = new Float64Array(frameCount);
  let previous = null;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = frameIndex * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i += 1) frame[i] = Number(samples[offset + i] || 0) * window[i];
    fft.realTransform(fftOut, frame);

    const magnitudes = new Float64Array((FRAME_SIZE / 2) + 1);
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      const re = fftOut[2 * bin] || 0;
      const im = fftOut[(2 * bin) + 1] || 0;
      magnitudes[bin] = Math.log1p(Math.hypot(re, im));
    }

    if (previous) {
      let sum = 0;
      for (let bin = 1; bin < magnitudes.length; bin += 1) {
        const diff = magnitudes[bin] - previous[bin];
        if (diff > 0) sum += diff;
      }
      flux[frameIndex] = sum;
    }
    previous = magnitudes;
  }

  const floor = median(flux);
  const rectified = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i += 1) rectified[i] = Math.max(0, flux[i] - floor);

  const smoothed = new Float64Array(rectified.length);
  for (let i = 0; i < rectified.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(rectified.length - 1, i + 1); j += 1) {
      sum += rectified[j];
      count += 1;
    }
    smoothed[i] = sum / Math.max(1, count);
  }

  const framesPerSecond = sampleRate / HOP_SIZE;
  const localRadius = Math.max(2, Math.round((LOCAL_MEAN_SECONDS * framesPerSecond) / 2));
  const localMean = movingAverage(smoothed, localRadius);
  const envelope = new Float64Array(smoothed.length);
  let peak = 0;
  for (let i = 0; i < smoothed.length; i += 1) {
    envelope[i] = Math.max(0, smoothed[i] - localMean[i]);
    peak = Math.max(peak, envelope[i]);
  }
  if (peak > 0) for (let i = 0; i < envelope.length; i += 1) envelope[i] /= peak;

  return { envelope, framesPerSecond };
}

function autocorrelationScore(envelope, lag) {
  if (lag <= 0 || lag >= envelope.length) return 0;
  let cross = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = lag; i < envelope.length; i += 1) {
    const a = envelope[i];
    const b = envelope[i - lag];
    cross += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  return cross / (Math.sqrt(energyA * energyB) + 1e-12);
}

function chooseTempo(envelope, framesPerSecond) {
  const minLag = Math.max(1, Math.round((framesPerSecond * 60) / BPM_MAX));
  const maxLag = Math.min(envelope.length - 1, Math.round((framesPerSecond * 60) / BPM_MIN));
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores = new Map();

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = autocorrelationScore(envelope, lag);
    scores.set(lag, score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const baseBpm = (60 * framesPerSecond) / bestLag;
  const halfLag = Math.max(minLag, Math.round(bestLag / 2));
  const doubleScore = scores.get(halfLag) ?? autocorrelationScore(envelope, halfLag);
  const doubleBpm = (60 * framesPerSecond) / halfLag;
  const doubleRatio = bestScore > 0 ? doubleScore / bestScore : 0;

  const useDoublePulse = baseBpm < 100 && doubleBpm >= 90 && doubleBpm <= 190 && doubleRatio >= 0.38;
  const pulseBpm = useDoublePulse ? doubleBpm : baseBpm;
  const confidence = clamp01((bestScore - 0.15) / 0.65);

  return {
    baseBpm,
    pulseBpm,
    bestLag,
    bestScore,
    doubleBpm,
    doubleScore,
    doubleRatio,
    metricalMode: useDoublePulse ? 'double-pulse' : 'base-pulse',
    confidence,
  };
}

function chooseBeatPhase(envelope, framesPerSecond, pulseBpm) {
  if (!Number.isFinite(pulseBpm) || pulseBpm <= 0 || !envelope.length) return { phaseSeconds: 0, phaseScore: 0 };
  const periodSeconds = 60 / pulseBpm;
  const periodFrames = periodSeconds * framesPerSecond;
  const maxOffset = Math.max(1, Math.round(periodFrames));
  let bestOffset = 0;
  let bestScore = -Infinity;

  for (let offset = 0; offset < maxOffset; offset += 1) {
    let score = 0;
    let count = 0;
    for (let position = offset; position < envelope.length; position += periodFrames) {
      const center = Math.round(position);
      let localPeak = 0;
      for (let j = Math.max(0, center - PHASE_SEARCH_RADIUS_FRAMES); j <= Math.min(envelope.length - 1, center + PHASE_SEARCH_RADIUS_FRAMES); j += 1) {
        localPeak = Math.max(localPeak, envelope[j]);
      }
      score += localPeak;
      count += 1;
    }
    const normalized = score / Math.max(1, count);
    if (normalized > bestScore) {
      bestScore = normalized;
      bestOffset = offset;
    }
  }

  return {
    phaseSeconds: bestOffset / framesPerSecond,
    phaseScore: clamp01(bestScore),
  };
}

function makeBeatTimes(durationSeconds, phaseSeconds, pulseBpm) {
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(pulseBpm) || pulseBpm <= 0) return [];
  const period = 60 / pulseBpm;
  let first = phaseSeconds;
  while (first - period >= 0) first -= period;
  while (first > 0) first -= period;
  const beats = [];
  for (let t = first; t <= durationSeconds + period; t += period) {
    if (t >= -0.001 && t <= durationSeconds + 0.001) beats.push(Number(Math.max(0, t).toFixed(6)));
  }
  return beats;
}

export function analyzeTempoSamples(samples, sampleRate) {
  const durationSeconds = samples?.length ? samples.length / sampleRate : 0;
  const { envelope, framesPerSecond } = buildOnsetEnvelope(samples, sampleRate);
  if (envelope.length < 32) {
    return {
      available: false,
      error: 'Audio is too short for tempo analysis.',
      durationSeconds,
      bpm: null,
      pulseBpm: null,
      confidence: 0,
      beatTimes: [],
    };
  }

  const tempo = chooseTempo(envelope, framesPerSecond);
  const phase = chooseBeatPhase(envelope, framesPerSecond, tempo.pulseBpm);
  const pulsePeriodSeconds = 60 / tempo.pulseBpm;
  const beatTimes = makeBeatTimes(durationSeconds, phase.phaseSeconds, tempo.pulseBpm);

  return {
    available: true,
    method: 'spectral-flux-autocorrelation-v1',
    durationSeconds,
    bpm: Number(tempo.baseBpm.toFixed(3)),
    pulseBpm: Number(tempo.pulseBpm.toFixed(3)),
    confidence: Number(tempo.confidence.toFixed(4)),
    autocorrelation: Number(tempo.bestScore.toFixed(4)),
    metricalMode: tempo.metricalMode,
    doubleTempoCandidate: Number(tempo.doubleBpm.toFixed(3)),
    doubleTempoRatio: Number(tempo.doubleRatio.toFixed(4)),
    pulsePeriodSeconds: Number(pulsePeriodSeconds.toFixed(6)),
    phaseSeconds: Number(phase.phaseSeconds.toFixed(6)),
    phaseScore: Number(phase.phaseScore.toFixed(4)),
    beatTimes,
    suggestedSlotsPerPulse: 2,
    suggestedSlotSeconds: Number((pulsePeriodSeconds / 2).toFixed(6)),
  };
}

export function analyzeTempo(audioBuffer) {
  if (!audioBuffer) return { available: false, error: 'No audio buffer.', beatTimes: [] };
  const channels = Math.max(1, audioBuffer.numberOfChannels || 1);
  const length = audioBuffer.length || audioBuffer.getChannelData(0).length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }
  return analyzeTempoSamples(mono, audioBuffer.sampleRate);
}
