import { readFileSync } from 'node:fs';
import { normalizedLogMel3s, SEGMENT_SAMPLES } from '../src/guitarEarFrontend.js';

const [waveformPath, referencePath] = process.argv.slice(2);
if (!waveformPath || !referencePath) {
  throw new Error('Usage: node scripts/test-guitar-ear-frontend.mjs <waveform.f32> <reference-logmel.f32>');
}

function readFloat32(path) {
  const buffer = readFileSync(path);
  if (buffer.byteLength % 4 !== 0) throw new Error(`Invalid float32 file length: ${path}`);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

const waveformRaw = readFloat32(waveformPath);
const referenceRaw = readFloat32(referencePath);
const waveform = new Float32Array(waveformRaw);
const reference = new Float32Array(referenceRaw);

if (waveform.length !== SEGMENT_SAMPLES) {
  throw new Error(`Expected ${SEGMENT_SAMPLES} waveform samples, got ${waveform.length}`);
}

const actual = normalizedLogMel3s(waveform);
if (actual.length !== reference.length) {
  throw new Error(`Frontend shape mismatch: actual=${actual.length}, reference=${reference.length}`);
}

let maxAbs = 0;
let sumSquared = 0;
let worstIndex = -1;
for (let i = 0; i < actual.length; i += 1) {
  const error = Math.abs(actual[i] - reference[i]);
  sumSquared += error * error;
  if (error > maxAbs) {
    maxAbs = error;
    worstIndex = i;
  }
}
const rmse = Math.sqrt(sumSquared / actual.length);

console.log(`FRONTEND_PARITY_MAX_ABS=${maxAbs}`);
console.log(`FRONTEND_PARITY_RMSE=${rmse}`);
console.log(`FRONTEND_PARITY_WORST_INDEX=${worstIndex}`);
if (worstIndex >= 0) {
  console.log(`FRONTEND_PARITY_ACTUAL=${actual[worstIndex]}`);
  console.log(`FRONTEND_PARITY_REFERENCE=${reference[worstIndex]}`);
}

const maxAbsLimit = Number(process.env.FRONTEND_MAX_ABS || '0.0005');
const rmseLimit = Number(process.env.FRONTEND_RMSE || '0.0001');
if (maxAbs > maxAbsLimit || rmse > rmseLimit) {
  throw new Error(`Guitar Ear frontend parity failed: maxAbs=${maxAbs} (limit ${maxAbsLimit}), rmse=${rmse} (limit ${rmseLimit})`);
}

console.log('GUITAR_EAR_FRONTEND_PARITY_OK');
