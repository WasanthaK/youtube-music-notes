#!/usr/bin/env node
// Run the extension's transcription pipeline (src/pipeline.js) on a WAV file, in Node.
// Run from extension/:  node tools/transcribe.mjs <in.wav> <out.json> [options]
// See usage() below.

import fs from 'node:fs';
import path from 'node:path';
import { readWav } from './lib/wav.mjs';
import { resample, resamplerDescription } from './lib/resample.mjs';

const BASIC_PITCH_RATE = 22050;
const GUITAR_EAR_RATE = 16000;
const BENCHMARK_MODE = 'node-cli-v1';

function usage() {
  return `Usage: node tools/transcribe.mjs <in.wav> <out.json> [--instrument guitar|flute] [--no-guitar-ear] [--dump-stages]
       node tools/transcribe.mjs --notes-in <ref.json> <out.json>

Runs the Chrome extension's transcription pipeline (transcribeAudio in src/pipeline.js) on a
WAV file and writes the same result object the extension produces, as JSON.

  <in.wav>              PCM 16/24/32-bit integer or 32-bit float WAV, any channel count
                        (channels are averaged to mono; WAVE_FORMAT_EXTENSIBLE is accepted).
  <out.json>            Output file for the result object.
  --instrument NAME     guitar (default) or flute.
  --no-guitar-ear       Do not run the Guitar Ear model; guitar transcription then uses the
                        Basic Pitch fallback, as the extension does when Guitar Ear fails.
  --dump-stages         Also write <out>.stages.json (<out.json> with .json replaced by .stages.json):
                        {basic_pitch, guitar_ear_gate, decoder, final}, each an array of
                        {start, end, midi, string, fret} (string/fret null when not yet assigned).
                        Stages the chosen path does not have are empty arrays.
  --notes-in REF.json   Skip all audio work and run only the fretboard assignment (the same solver
                        as the pipeline) on the notes in REF.json: an array of {start, end, midi}
                        or {"notes": [...]}. <in.wav> is not used in this mode; give only <out.json>.
                        The output has the normal result shape with guitar.string/guitar.fret filled
                        (guitar is null for a note the solver cannot place).
  -h, --help            Show this help.

Engines: Basic Pitch via @spotify/basic-pitch on the TensorFlow.js CPU backend (model from
node_modules/@spotify/basic-pitch/model), Guitar Ear via onnxruntime-node (model from
public/models/guitar-ear-v0.2d-core.onnx) with the extension's own inference code
(src/guitarEarCore.js).

Resampling: the extension resamples with Chrome's OfflineAudioContext, whose output cannot
be reproduced outside Chrome. This tool uses a deterministic band-limited resampler instead,
to ${BASIC_PITCH_RATE} Hz for Basic Pitch and ${GUITAR_EAR_RATE} Hz for Guitar Ear:
${resamplerDescription}.
Results are therefore close to, but not bit-identical with, the extension's for the
same audio. The extension also decodes compressed tab audio; this tool reads WAV only.

Progress goes to stderr. Exit code 0 on success, 1 on any failure, 2 on bad arguments.`;
}

class UsageError extends Error {}
// Expected failures (bad input files etc.): reported without a stack trace.
class CliError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const options = { instrument: 'guitar', guitarEar: true, dumpStages: false, notesIn: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-guitar-ear') options.guitarEar = false;
    else if (arg === '--dump-stages') options.dumpStages = true;
    else if (arg === '--notes-in' || arg.startsWith('--notes-in=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value) throw new UsageError('--notes-in needs a file path');
      options.notesIn = value;
    }
    else if (arg === '--instrument' || arg.startsWith('--instrument=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (value !== 'guitar' && value !== 'flute') throw new UsageError(`--instrument must be guitar or flute, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`);
      options.instrument = value;
    } else if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (options.help) return options;
  if (options.notesIn) {
    if (positional.length !== 1) throw new UsageError(`with --notes-in expected only <out.json>, got ${positional.length} argument${positional.length === 1 ? '' : 's'}`);
    if (options.dumpStages) throw new UsageError('--dump-stages cannot be combined with --notes-in (no pipeline stages run)');
    [options.output] = positional;
    return options;
  }
  if (positional.length !== 2) throw new UsageError(`expected <in.wav> and <out.json>, got ${positional.length} argument${positional.length === 1 ? '' : 's'}`);
  [options.input, options.output] = positional;
  return options;
}

const log = message => process.stderr.write(`[transcribe] ${message}\n`);

// The result is plain data, but make sure typed arrays serialise as arrays.
function jsonReplacer(key, value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value);
  return value;
}

// Normalise a pipeline note for the stages dump.
const stageNote = note => ({
  start: note.start,
  end: note.end,
  midi: note.midi,
  string: Number.isFinite(note.guitar?.string) ? note.guitar.string : null,
  fret: Number.isFinite(note.guitar?.fret) ? note.guitar.fret : null,
});

// --notes-in: no audio, only the fretboard solver (assignNotesToGuitar in src/guitarEnginePhase2d.js).
async function runNotesIn(args, started) {
  const notesPath = path.resolve(args.notesIn);
  const outputPath = path.resolve(args.output);
  if (!fs.existsSync(notesPath)) throw new CliError(`notes file not found: ${notesPath}`);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) throw new CliError(`output directory does not exist: ${outputDir}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
  } catch (error) {
    throw new CliError(`cannot read ${path.basename(notesPath)}: ${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.notes;
  if (!Array.isArray(list)) throw new CliError(`${path.basename(notesPath)} must be an array of notes or {"notes": [...]}`);
  list.forEach((note, index) => {
    if (![note?.start, note?.end, note?.midi].every(Number.isFinite)) throw new CliError(`note ${index} in ${path.basename(notesPath)} needs numeric start, end and midi`);
  });

  let assignNotesToGuitar;
  try {
    ({ assignNotesToGuitar } = await import('../src/guitarEnginePhase2d.js'));
  } catch (error) {
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND' ? /Cannot find package '([^']+)'/.exec(error.message)?.[1] : null;
    if (missing) throw new CliError(`npm package "${missing}" is not installed; run npm install in extension/ first`);
    throw error;
  }
  const notes = assignNotesToGuitar(list);
  const unplaced = notes.filter(note => !note.guitar).length;
  if (unplaced) log(`WARNING: ${unplaced} note${unplaced === 1 ? '' : 's'} could not be placed on the fretboard (guitar: null)`);
  const duration = notes.reduce((max, note) => Math.max(max, note.end), 0);
  const result = {
    title: path.basename(notesPath),
    instrument: 'guitar',
    mode: 'transcribe',
    duration_seconds: duration,
    notes,
    warnings: ['Notes supplied by --notes-in; only the fretboard assignment was run.'],
    midi_base64: null,
    engine: 'notes-in-fretboard-solver',
    summary: { playableNotes: notes.length, unplacedNotes: unplaced, durationSeconds: duration },
    benchmark: null,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, jsonReplacer, 2)}\n`);
  log(`${notes.length} notes assigned, ${((Date.now() - started) / 1000).toFixed(1)} s elapsed`);
  log(`wrote ${outputPath}`);
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`transcribe: ${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  // Libraries (TensorFlow.js, pipeline warnings) may log to stdout; keep stdout clean and
  // send everything to stderr.
  console.log = (...items) => console.error(...items);
  console.info = (...items) => console.error(...items);

  const started = Date.now();
  if (args.notesIn) return runNotesIn(args, started);
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  if (!fs.existsSync(inputPath)) throw new CliError(`input file not found: ${inputPath}`);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) throw new CliError(`output directory does not exist: ${outputDir}`);

  log(`reading ${inputPath}`);
  let wav;
  try {
    wav = readWav(fs.readFileSync(inputPath));
  } catch (error) {
    throw new CliError(`cannot read ${path.basename(inputPath)}: ${error.message}`);
  }
  log(`WAV ${wav.encoding}${wav.extensible ? ' (extensible)' : ''}, ${wav.channels} channel${wav.channels === 1 ? '' : 's'}, ${wav.sampleRate} Hz, ${wav.durationSeconds.toFixed(3)} s`);
  if (!wav.frames) throw new CliError('WAV file contains no audio samples');

  log(`resampling to ${BASIC_PITCH_RATE} Hz`);
  const basicPitchSamples = resample(wav.mono, wav.sampleRate, BASIC_PITCH_RATE);
  // Mirrors offscreen-phase2d.js: durationSeconds is the duration of the 22050 Hz buffer.
  const durationSeconds = basicPitchSamples.length / BASIC_PITCH_RATE;

  // Imported after argument and input checks so that --help and bad input fail fast,
  // and so that a missing package is reported as a clear error below.
  let transcribeAudio;
  let runBasicPitchNode;
  try {
    ({ transcribeAudio } = await import('../src/pipeline.js'));
    ({ runBasicPitchNode } = await import('./lib/basicPitchNode.mjs'));
  } catch (error) {
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND' ? /Cannot find package '([^']+)'/.exec(error.message)?.[1] : null;
    if (missing) throw new CliError(`npm package "${missing}" is not installed; run npm install in extension/ first`);
    throw error;
  }

  let lastPercent = -1;
  const deps = {
    runBasicPitch: (samples, sampleRate) => runBasicPitchNode(samples, sampleRate, {
      log,
      onProgress: fraction => {
        const percent = Math.round(fraction * 100);
        if (percent >= lastPercent + 10 || (percent === 100 && lastPercent !== 100)) {
          lastPercent = percent;
          log(`Basic Pitch… ${percent}%`);
        }
      },
    }),
    runGuitarEar: async () => {
      if (!args.guitarEar) {
        return { available: false, error: 'Guitar Ear disabled by --no-guitar-ear (node CLI).' };
      }
      log(`resampling to ${GUITAR_EAR_RATE} Hz for Guitar Ear`);
      const guitarEarSamples = resample(wav.mono, wav.sampleRate, GUITAR_EAR_RATE);
      const { analyzeGuitarEarNode } = await import('./lib/guitarEarNode.mjs');
      const result = await analyzeGuitarEarNode(guitarEarSamples, GUITAR_EAR_RATE);
      if (result.available) {
        log(`Guitar Ear ${result.model} (${result.phase}, ${result.device}): mean presence ${Number(result.meanPresence).toFixed(3)}, ${result.attackCount} attacks`);
      } else {
        log(`WARNING: Guitar Ear unavailable: ${result.error}`);
      }
      return result;
    },
    reportProgress: async message => { log(message); },
  };

  // Capture metadata, as the extension's BEGIN_RECORDING message would carry it.
  const options = {
    instrument: args.instrument,
    title: path.basename(inputPath),
    mode: 'transcribe',
    benchmarkMode: BENCHMARK_MODE,
    startSeconds: 0,
    endSeconds: wav.durationSeconds,
  };
  const stages = { basic_pitch: [], guitar_ear_gate: [], decoder: [], final: [] };
  if (args.dumpStages) {
    options.onStage = (name, notes) => { stages[name] = notes.map(stageNote); };
  }

  const result = await transcribeAudio(
    { samples: basicPitchSamples, sampleRate: BASIC_PITCH_RATE, durationSeconds },
    deps,
    options,
  );

  fs.writeFileSync(outputPath, `${JSON.stringify(result, jsonReplacer, 2)}\n`);
  if (args.dumpStages) {
    const stagesPath = outputPath.replace(/\.json$/i, '') + '.stages.json';
    fs.writeFileSync(stagesPath, `${JSON.stringify(stages, null, 2)}\n`);
    log(`wrote ${stagesPath}`);
  }
  log(`engine ${result.engine}, ${result.notes?.length ?? 0} notes, ${durationSeconds.toFixed(3)} s of audio, ${((Date.now() - started) / 1000).toFixed(1)} s elapsed`);
  log(`wrote ${outputPath}`);
  return 0;
}

// process.exit() rather than exitCode: native runtimes may keep handles open after the run.
// (stderr writes to files and pipes are synchronous on Linux, so nothing is lost.)
main().then(
  code => process.exit(code),
  error => {
    process.stderr.write(`transcribe: error: ${error?.message || error}\n`);
    if (!(error instanceof CliError) && error?.stack) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  },
);
