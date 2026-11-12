// Tests the Node transcription CLI (tools/transcribe.mjs) and its WAV/resampler helpers.
//
// (i)   WAV reader: round-trips a synthesised guitar-like clip through every supported
//       encoding (PCM 16/24/32, float 32, plain and WAVE_FORMAT_EXTENSIBLE, mono and stereo)
//       and checks that unsupported files are rejected with a clear error.
// (ii)  Resampler: a 1 kHz sine at 44.1 kHz resampled to 16 kHz keeps its frequency within
//       1 Hz (zero-crossing measurement) and its amplitude; a 10 kHz sine is removed.
// (iii) CLI: writes the clip to a temporary WAV, runs the CLI as a child process and checks
//       the result object. Needs node_modules (npm install); skipped when absent.
//
// No audio file is committed: the clip is synthesised here (Karplus-Strong plucked strings).
// Run from extension/: node scripts/test-node-transcribe.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeWav, readWav } from '../tools/lib/wav.mjs';
import { resample } from '../tools/lib/resample.mjs';

const SAMPLE_RATE = 44100;
const CLIP_SECONDS = 6;
const CLI_TIMEOUT_MS = 14 * 60 * 1000;

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

// ---------------------------------------------------------------------------------------------
// Deterministic guitar-like clip: four single notes, then a three-note chord.
const SINGLE_NOTES = [
  { midi: 55, start: 0.25 }, // G3
  { midi: 59, start: 1.05 }, // B3
  { midi: 62, start: 1.85 }, // D4
  { midi: 64, start: 2.65 }, // E4
];
const CHORD = { midis: [48, 52, 55], start: 3.5 }; // C3 E3 G3 (C major)
const SYNTH_PITCHES = [...new Set([...SINGLE_NOTES.map(note => note.midi), ...CHORD.midis])];

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Karplus-Strong plucked string, `seconds` long. The two-point average in the loop adds half a
// sample of delay, so the delay line is (period - 0.5) samples.
function pluck(midi, seconds, random, decay = 0.996) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const delay = Math.max(2, Math.round(SAMPLE_RATE / frequency - 0.5));
  const line = new Float64Array(delay);
  let previous = 0;
  for (let i = 0; i < delay; i += 1) {
    const noise = random() * 2 - 1;
    line[i] = 0.5 * (noise + previous); // soften the burst a little
    previous = noise;
  }
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let index = 0;
  for (let n = 0; n < out.length; n += 1) {
    const next = (index + 1) % delay;
    const value = line[index];
    line[index] = decay * 0.5 * (value + line[next]);
    out[n] = value;
    index = next;
  }
  return out;
}

function synthesiseClip() {
  const random = makeRandom(20251112);
  const mix = new Float64Array(CLIP_SECONDS * SAMPLE_RATE);
  const add = (samples, startSeconds, gain) => {
    const offset = Math.round(startSeconds * SAMPLE_RATE);
    for (let i = 0; i < samples.length && offset + i < mix.length; i += 1) {
      // Short fade-out at the end of each note so the next attack is clean.
      const remaining = samples.length - i;
      const fade = remaining < 441 ? remaining / 441 : 1;
      mix[offset + i] += gain * fade * samples[i];
    }
  };
  for (const note of SINGLE_NOTES) add(pluck(note.midi, 0.8, random), note.start, 1);
  CHORD.midis.forEach((midi, i) => add(pluck(midi, CLIP_SECONDS - CHORD.start, random), CHORD.start + i * 0.02, 0.6));
  let peak = 0;
  for (const value of mix) peak = Math.max(peak, Math.abs(value));
  const clip = new Float32Array(mix.length);
  for (let i = 0; i < mix.length; i += 1) {
    // Quantise to 16-bit levels so the 16-bit round trip is exact.
    clip[i] = Math.round((0.8 * mix[i] / peak) * 32767) / 32768;
  }
  return clip;
}

const maxAbsDiff = (a, b) => {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
};

const clip = synthesiseClip();
console.log(`clip: ${CLIP_SECONDS} s, ${SAMPLE_RATE} Hz, 16-bit mono; pitches ${SYNTH_PITCHES.join(', ')}`);

// ---------------------------------------------------------------------------------------------
console.log('(i) WAV reader');
{
  const wav16 = readWav(encodeWav([clip], SAMPLE_RATE, { encoding: 'pcm16' }));
  check(
    wav16.sampleRate === SAMPLE_RATE && wav16.channels === 1 && wav16.frames === clip.length && wav16.encoding === 'pcm16',
    `16-bit mono header: ${wav16.sampleRate} Hz, ${wav16.channels} ch, ${wav16.frames} frames, ${wav16.encoding}`,
  );
  const diff16 = maxAbsDiff(wav16.mono, clip);
  check(diff16 === 0, `16-bit mono round trip is exact (max |diff| ${diff16})`);
  check(Math.abs(wav16.durationSeconds - CLIP_SECONDS) < 1e-9, `duration ${wav16.durationSeconds} s`);

  const tolerances = { pcm16: 1 / 32768, pcm24: 1 / 8388608, pcm32: 1e-9, float32: 1e-7 };
  for (const encoding of ['pcm16', 'pcm24', 'pcm32', 'float32']) {
    for (const extensible of [false, true]) {
      // Stereo: left = clip, right = -0.5 * clip, so the mono average is 0.25 * clip.
      const right = clip.map(value => -0.5 * value);
      const decoded = readWav(encodeWav([clip, right], SAMPLE_RATE, { encoding, extensible }));
      const expected = clip.map(value => 0.25 * value);
      const diff = Math.max(maxAbsDiff(decoded.channelData[0], clip), maxAbsDiff(decoded.mono, expected));
      check(
        decoded.encoding === encoding && decoded.extensible === extensible && decoded.channels === 2 && diff <= tolerances[encoding],
        `${encoding}${extensible ? ' extensible' : ''} stereo round trip and mono average (max |diff| ${diff.toExponential(2)})`,
      );
    }
  }

  // 3 channels, extensible: averaged to mono.
  const three = readWav(encodeWav([clip, clip, new Float32Array(clip.length)], SAMPLE_RATE, { encoding: 'float32', extensible: true }));
  const threeDiff = maxAbsDiff(three.mono, clip.map(value => (2 * value) / 3));
  check(three.channels === 3 && threeDiff < 1e-7, `3-channel float32 extensible averaged to mono (max |diff| ${threeDiff.toExponential(2)})`);

  // Unsupported input is rejected with a clear message.
  const expectError = (label, bytes, pattern) => {
    try {
      readWav(bytes);
      check(false, `${label}: rejected`);
    } catch (error) {
      check(pattern.test(error.message), `${label}: rejected with "${error.message}"`);
    }
  };
  const pcm8 = encodeWav([clip.subarray(0, 100)], SAMPLE_RATE, { encoding: 'pcm16' });
  const view = new DataView(pcm8.buffer);
  view.setUint16(32, 1, true); // block align 1
  view.setUint16(34, 8, true); // 8-bit
  expectError('8-bit PCM', pcm8, /unsupported WAV encoding: PCM, 8-bit/);
  const alaw = encodeWav([clip.subarray(0, 100)], SAMPLE_RATE, { encoding: 'pcm16' });
  new DataView(alaw.buffer).setUint16(20, 6, true); // WAVE_FORMAT_ALAW
  expectError('A-law', alaw, /unsupported WAV encoding: format code 0x0006/);
  expectError('non-WAV bytes', new TextEncoder().encode('ID3 this is not a wav file'), /not a WAV file/);
}

// ---------------------------------------------------------------------------------------------
console.log('(ii) resampler');
{
  const seconds = 2;
  const sine = new Float32Array(SAMPLE_RATE * seconds);
  for (let i = 0; i < sine.length; i += 1) sine[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
  const out = resample(sine, SAMPLE_RATE, 16000);
  check(out.length === 16000 * seconds, `length ${out.length} (expected ${16000 * seconds})`);

  // Frequency from interpolated upward zero crossings, away from the edges.
  const crossings = [];
  for (let i = 1000; i < out.length - 1000; i += 1) {
    if (out[i - 1] < 0 && out[i] >= 0) crossings.push((i - 1) + out[i - 1] / (out[i - 1] - out[i]));
  }
  const frequency = ((crossings.length - 1) * 16000) / (crossings[crossings.length - 1] - crossings[0]);
  check(Math.abs(frequency - 1000) < 1, `1 kHz sine at 44.1 kHz -> 16 kHz measures ${frequency.toFixed(4)} Hz`);

  let peak = 0;
  for (let i = 1000; i < out.length - 1000; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  check(Math.abs(peak - 0.8) < 0.01, `amplitude kept (peak ${peak.toFixed(4)}, input 0.8)`);

  const high = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < high.length; i += 1) high[i] = Math.sin((2 * Math.PI * 10000 * i) / SAMPLE_RATE);
  const highOut = resample(high, SAMPLE_RATE, 16000);
  let sum = 0;
  for (let i = 1000; i < highOut.length - 1000; i += 1) sum += highOut[i] * highOut[i];
  const rms = Math.sqrt(sum / (highOut.length - 2000));
  check(rms < 1e-3, `10 kHz sine (above the 8 kHz Nyquist) is removed (rms ${rms.toExponential(2)})`);

  const again = resample(sine, SAMPLE_RATE, 16000);
  check(maxAbsDiff(again, out) === 0, 'deterministic: a second run gives identical output');

  const toBasicPitch = resample(clip, SAMPLE_RATE, 22050);
  check(toBasicPitch.length === Math.ceil(CLIP_SECONDS * 22050), `clip -> 22050 Hz: ${toBasicPitch.length} samples`);
}

// ---------------------------------------------------------------------------------------------
console.log('(iii) CLI: node tools/transcribe.mjs on the synthesised clip');
if (!fs.existsSync('node_modules')) {
  console.log('  SKIPPED: no node_modules here (run npm install first). CI installs dependencies, so (iii) runs there.');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymn-transcribe-'));
  try {
    const wavPath = path.join(dir, 'synth-guitar.wav');
    const outPath = path.join(dir, 'synth-guitar.json');
    fs.writeFileSync(wavPath, encodeWav([clip], SAMPLE_RATE, { encoding: 'pcm16' }));
    const started = Date.now();
    const run = spawnSync(
      process.execPath,
      ['tools/transcribe.mjs', wavPath, outPath, '--instrument', 'guitar'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: CLI_TIMEOUT_MS },
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    check(run.status === 0, `CLI exit code ${run.status}${run.signal ? ` (signal ${run.signal})` : ''}${run.error ? ` (${run.error.message})` : ''} after ${seconds} s`);

    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      check(true, 'output JSON parses');
    } catch (error) {
      check(false, `output JSON parses (${error.message})`);
    }

    if (result) {
      check(typeof result.engine === 'string' && result.engine.length > 0, `engine "${result.engine}"`);
      check(result.instrument === 'guitar', `instrument "${result.instrument}"`);
      check(result.title === 'synth-guitar.wav', `title "${result.title}"`);
      check(result.mode === 'transcribe', `mode "${result.mode}"`);
      check(
        typeof result.duration_seconds === 'number' && Math.abs(result.duration_seconds - CLIP_SECONDS) <= 0.1,
        `duration_seconds ${result.duration_seconds} (clip ${CLIP_SECONDS} s)`,
      );
      const notes = Array.isArray(result.notes) ? result.notes : [];
      check(notes.length > 0, `notes is a non-empty array (${notes.length})`);
      const numeric = value => typeof value === 'number' && Number.isFinite(value);
      const badShape = notes.filter(note => !numeric(note.start) || !numeric(note.end) || !numeric(note.midi));
      check(notes.length > 0 && badShape.length === 0, `every note has numeric start, end, midi (${badShape.length} bad)`);
      const detected = [...new Set(notes.map(note => note.midi))].sort((a, b) => a - b);
      const found = SYNTH_PITCHES.filter(midi => detected.some(value => Math.abs(value - midi) <= 1));
      check(
        found.length * 2 >= SYNTH_PITCHES.length,
        `${found.length}/${SYNTH_PITCHES.length} synthesised pitches detected within ±1 semitone (synth ${SYNTH_PITCHES.join(',')}; detected ${detected.join(',')})`,
      );
      const noPosition = notes.filter(note => !numeric(note.guitar?.string) || !numeric(note.guitar?.fret));
      check(notes.length > 0 && noPosition.length === 0, `every note has guitar.string and guitar.fret (${noPosition.length} missing)`);
      const guitarEar = result.summary?.guitarEar;
      check(
        guitarEar?.available === true,
        `Guitar Ear ran through onnxruntime-node (available ${guitarEar?.available}${guitarEar?.error ? `, error: ${guitarEar.error}` : ''})`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.log(`NODE_TRANSCRIBE_TEST_FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('NODE_TRANSCRIBE_TEST_OK');
