// Deterministic band-limited (windowed-sinc) resampler in plain JavaScript.
//
// The extension resamples with Chrome's OfflineAudioContext (src/offscreen-phase2d.js,
// resampleMono). Chrome's resampler is internal to the browser and its output cannot be
// reproduced bit-for-bit in Node, so CLI results can differ slightly from the extension's
// for the same audio. This resampler is a Kaiser-windowed sinc low-pass evaluated at every
// output instant: the same input always gives the same output, on any machine.
//
// Output length follows resampleMono(): Math.max(1, Math.ceil(duration * outRate)), where
// duration = input length / input rate.

const ZERO_CROSSINGS = 32;   // half-width of the kernel, in zero crossings of the low-pass sinc
const ROLLOFF = 0.95;        // cutoff as a fraction of the lower Nyquist frequency
const KAISER_BETA = 9;       // ~90 dB stop-band attenuation
const TABLE_STEPS = 512;     // kernel table resolution, in steps per input sample

function besselI0(x) {
  // Power series; converges quickly for the beta values used here.
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 64; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

const kernelCache = new Map();

// Kernel h(x), x in input samples, tabulated for |x| in [0, halfWidth] at TABLE_STEPS per sample.
function kernelTable(cutoff) {
  const key = cutoff.toPrecision(17);
  if (kernelCache.has(key)) return kernelCache.get(key);
  const halfWidth = ZERO_CROSSINGS / (2 * cutoff);
  const size = Math.ceil(halfWidth * TABLE_STEPS) + 2;
  const table = new Float64Array(size);
  const i0Beta = besselI0(KAISER_BETA);
  for (let i = 0; i < size; i += 1) {
    const x = i / TABLE_STEPS;
    if (x >= halfWidth) { table[i] = 0; continue; }
    const arg = 2 * cutoff * x;
    const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
    const r = x / halfWidth;
    const window = besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0Beta;
    table[i] = 2 * cutoff * sinc * window;
  }
  const entry = { table, halfWidth };
  kernelCache.set(key, entry);
  return entry;
}

export function resampledLength(inputLength, inputRate, outputRate) {
  return Math.max(1, Math.ceil((inputLength / inputRate) * outputRate));
}

/**
 * Resample mono samples.
 * @param {Float32Array} input
 * @param {number} inputRate   Hz
 * @param {number} outputRate  Hz
 * @returns {Float32Array}
 */
export function resample(input, inputRate, outputRate) {
  if (!(input instanceof Float32Array)) throw new TypeError('resample: input must be a Float32Array');
  if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError('resample: sample rates must be positive');
  const outLength = resampledLength(input.length, inputRate, outputRate);
  const output = new Float32Array(outLength);
  if (inputRate === outputRate) {
    output.set(input.subarray(0, outLength));
    return output;
  }

  // Cutoff in cycles per input sample.
  const cutoff = 0.5 * ROLLOFF * Math.min(1, outputRate / inputRate);
  const { table, halfWidth } = kernelTable(cutoff);
  const ratio = inputRate / outputRate;
  const n = input.length;

  for (let j = 0; j < outLength; j += 1) {
    const t = j * ratio;
    const first = Math.max(0, Math.ceil(t - halfWidth));
    const last = Math.min(n - 1, Math.floor(t + halfWidth));
    let acc = 0;
    for (let k = first; k <= last; k += 1) {
      const pos = Math.abs(k - t) * TABLE_STEPS;
      const index = Math.floor(pos);
      const frac = pos - index;
      const weight = table[index] + (table[index + 1] - table[index]) * frac;
      acc += input[k] * weight;
    }
    output[j] = acc;
  }
  return output;
}

export const resamplerDescription =
  `Kaiser-windowed sinc (${ZERO_CROSSINGS} zero crossings, beta ${KAISER_BETA}, cutoff ${ROLLOFF} x lower Nyquist)`;
