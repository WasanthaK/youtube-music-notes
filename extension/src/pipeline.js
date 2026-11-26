// Environment-neutral transcription pipeline.
//
// transcribeAudio() takes already-decoded mono samples and returns the finished
// analysis result object. It does no audio decoding or resampling, no storage,
// no messaging and no network access. Everything that depends on the host
// environment (model inference, progress reporting) is passed in through `deps`.
//
// Keep this file free of browser globals and Node-only modules:
// scripts/test-pipeline-purity.mjs and scripts/validate-v054.mjs enforce it.

import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { analyzeTempoSamples } from './tempoAnalysis.js';
import { buildGuitarTranscription } from './guitarEngine.js';
import { buildGuitarTranscriptionPhase2d } from './guitarEnginePhase2d.js';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const midiName = midi => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
export const perSecond = (count, duration) => duration > 0 ? count / duration : 0;

function reduceMelody(notes, minMidi, maxMidi) {
  const filtered = notes
    .filter(note => note.midi >= minMidi && note.midi <= maxMidi && note.confidence >= 0.18)
    .sort((a, b) => a.start - b.start || b.midi - a.midi);
  const out = [];
  for (const note of filtered) {
    if (!out.length || note.start - out[out.length - 1].start > 0.09) out.push(note);
    else if (note.confidence > out[out.length - 1].confidence) out[out.length - 1] = note;
  }
  return out;
}

function buildFluteTranscription(frames, onsets, contours) {
  const timed = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)
    )
  );
  const raw = timed.map(note => ({
    start: note.startTimeSeconds,
    end: note.startTimeSeconds + note.durationSeconds,
    midi: note.pitchMidi,
    confidence: note.amplitude,
    name: midiName(note.pitchMidi)
  }));
  const notes = reduceMelody(raw, 60, 96);
  return { raw, notes, summary: { rawCount: raw.length, playableNotes: notes.length } };
}

const noProgress = async () => {};

/**
 * Run the transcription pipeline on decoded mono audio.
 *
 * @param {object} input
 * @param {Float32Array} input.samples  Mono samples at input.sampleRate (Basic Pitch rate, 22050 Hz).
 * @param {number} input.sampleRate     Sample rate of input.samples.
 * @param {number} input.durationSeconds Duration of the 22050 Hz audio in seconds.
 * @param {object} deps
 * @param {(samples: Float32Array, sampleRate: number) => Promise<{frames: number[][], onsets: number[][], contours: number[][]}>} deps.runBasicPitch
 *        Runs Basic Pitch on the samples and returns its raw frame/onset/contour output.
 * @param {(input: object) => Promise<object>} [deps.runGuitarEar]
 *        Runs Guitar Ear and returns its result ({ available, error, ... }). Only called when
 *        the instrument is guitar. The implementation is responsible for obtaining the
 *        16 kHz audio it needs (the same `input` object is passed to it).
 * @param {(message: string) => Promise<void>} [deps.reportProgress]
 *        Progress callback. Awaited at the same points as before the extraction.
 * @param {object} options  Capture metadata (the BEGIN_RECORDING message): instrument, title,
 *        mode, videoId, videoUrl, benchmarkMode, startSeconds, endSeconds, requestedDurationSeconds.
 *        Optional options.onStage(name, notes) hook for evaluation tooling. Called synchronously with a
 *        deep copy of the notes at 'basic_pitch' (after Basic Pitch post-processing), 'guitar_ear_gate'
 *        (after the Guitar Ear gate/ensemble), 'decoder' (after the musical decoder) and 'final' (the
 *        returned notes). Stages a code path does not have are not reported: the flute path reports
 *        'basic_pitch' and 'final'; the guitar Basic Pitch fallback (Guitar Ear unavailable) reports
 *        only 'final'. Absent, nothing changes.
 * @returns {Promise<object>} The analysis result object.
 */
export async function transcribeAudio(input, deps, options) {
  const reportProgress = deps.reportProgress || noProgress;
  const captureMeta = options;
  const onStage = typeof options?.onStage === 'function'
    ? (name, stageNotes) => options.onStage(name, structuredClone(Array.from(stageNotes)))
    : null;
  const instrument = captureMeta.instrument || 'guitar';

  await reportProgress('Learning tempo and beat grid…');
  const tempo = analyzeTempoSamples(input.samples, input.sampleRate);
  let guitarEar = null;
  if (instrument === 'guitar') {
    await reportProgress('Guitar Ear Phase-2e is listening with rhythm conditioning…');
    guitarEar = await deps.runGuitarEar(input);
    if (!guitarEar.available) {
      console.warn('Browser Guitar Ear unavailable; using Basic Pitch fallback.', guitarEar.error);
      await reportProgress('Guitar Ear unavailable; continuing with Basic Pitch fallback…');
    }
  }

  await reportProgress('Transcribing locally with Basic Pitch…');
  const { frames, onsets, contours } = await deps.runBasicPitch(input.samples, input.sampleRate);
  const duration = input.durationSeconds;

  let notes;
  let summary;
  let engine;

  if (instrument === 'guitar') {
    const result = guitarEar?.available
      ? buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar, tempo, onStage)
      : buildGuitarTranscription(frames, onsets, contours);
    engine = result.engine;
    notes = result.notes.map(note => ({ ...note, name: midiName(note.midi) }));
    summary = {
      ...result.summary,
      ...(guitarEar?.available ? {
        guitarEar: {
          ...result.summary.guitarEar,
          inferenceMode: guitarEar.inferenceMode || null,
          windowStrideSeconds: guitarEar.windowStrideSeconds ?? null,
          activeSegmentFraction: guitarEar.activeSegmentFraction ?? null,
          segmentScores: guitarEar.segmentScores || [],
        },
      } : { guitarEar: guitarEar || { available: false } }),
      durationSeconds: duration,
      mergedPerSecond: perSecond(result.summary.mergedCandidates || 0, duration),
      teachingPerSecond: perSecond(result.summary.teachingCandidates || 0, duration),
      playablePerSecond: perSecond(result.summary.playableNotes || notes.length, duration),
      onsetGroupsPerSecond: perSecond(result.summary.onsetGroups || 0, duration),
    };
  } else {
    const result = buildFluteTranscription(frames, onsets, contours);
    engine = 'flute-basic-pitch-browser-v1';
    notes = result.notes;
    summary = { ...result.summary, durationSeconds: duration };
    if (onStage) onStage('basic_pitch', result.raw);
  }
  if (onStage) onStage('final', notes);

  const warnings = ['Automatic transcription is approximate on dense full mixes.'];
  if (instrument === 'guitar' && guitarEar && !guitarEar.available) {
    warnings.push(`Guitar Ear browser model unavailable: ${guitarEar.error || 'unknown error'}`);
  }

  return {
    title: captureMeta.title || 'Captured audio',
    instrument,
    mode: captureMeta.mode || 'transcribe',
    duration_seconds: duration,
    notes,
    warnings,
    midi_base64: null,
    engine,
    summary,
    benchmark: captureMeta.videoId ? {
      mode: captureMeta.benchmarkMode || 'fixed-30s-v1',
      videoId: captureMeta.videoId,
      videoUrl: captureMeta.videoUrl,
      startSeconds: captureMeta.startSeconds,
      endSeconds: captureMeta.endSeconds,
      requestedDurationSeconds: captureMeta.requestedDurationSeconds
    } : null
  };
}
