import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { analyzeGuitarEar } from './guitarEarBrowser.js';
import { buildGuitarTranscription } from './guitarEngine.js';
import { buildGuitarTranscriptionPhase2d } from './guitarEnginePhase2d.js';

const BASIC_PITCH_MODEL_URL = 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json';
const SUPABASE_URL = 'https://kgoowanohmtprbwdokjd.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4dlNhnTkkyQRx8CJTqWXfQ_tfx8bz-o';
const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';

let recorder = null;
let chunks = [];
let mediaStream = null;
let audioContext = null;
let captureMeta = null;

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const midiName = midi => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const perSecond = (count, duration) => duration > 0 ? count / duration : 0;

async function reportProgress(captureMessage) {
  try {
    await chrome.runtime.sendMessage({ type: 'ANALYSIS_PROGRESS', captureMessage });
  } catch {}
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveAnalysisResult(result) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(result, 'latest');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  } finally {
    db.close();
  }
}

async function beginRecording(message) {
  if (recorder?.state === 'recording') throw new Error('A recording is already in progress.');
  captureMeta = message;
  chunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  audioContext.createMediaStreamSource(mediaStream).connect(audioContext.destination);

  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm'];
  const mimeType = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
  recorder.start(1000);
}

async function decodeBlob(blob) {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await ctx.close();
  }
}

async function resampleMono(input, sampleRate) {
  const length = Math.max(1, Math.ceil(input.duration * sampleRate));
  const offline = new OfflineAudioContext(1, length, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = input;
  source.connect(offline.destination);
  source.start();
  return await offline.startRendering();
}

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
  return { notes, summary: { rawCount: raw.length, playableNotes: notes.length } };
}

async function runBasicPitch(audioBuffer) {
  const basicPitch = new BasicPitch(BASIC_PITCH_MODEL_URL);
  const frames = [];
  const onsets = [];
  const contours = [];

  await basicPitch.evaluateModel(
    audioBuffer,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    progress => {
      const pct = Math.round(progress * 100);
      void reportProgress(`Basic Pitch in Chrome… ${pct}%`);
    }
  );

  return { frames, onsets, contours };
}

async function analyseBlob(blob) {
  await reportProgress('Decoding captured audio locally…');
  const decoded = await decodeBlob(blob);
  const instrument = captureMeta.instrument || 'guitar';

  const basicPitchAudio = await resampleMono(decoded, 22050);
  let guitarEar = null;
  if (instrument === 'guitar') {
    await reportProgress('Guitar Ear Phase-2d is listening in Chrome…');
    const guitarEarAudio = await resampleMono(decoded, 16000);
    guitarEar = await analyzeGuitarEar(guitarEarAudio);
    if (!guitarEar.available) {
      console.warn('Browser Guitar Ear unavailable; using Basic Pitch fallback.', guitarEar.error);
      await reportProgress('Guitar Ear unavailable; continuing with browser Basic Pitch fallback…');
    }
  }

  await reportProgress('Transcribing locally with Basic Pitch…');
  const { frames, onsets, contours } = await runBasicPitch(basicPitchAudio);
  const duration = basicPitchAudio.duration;

  let notes;
  let summary;
  let engine;

  if (instrument === 'guitar') {
    const result = guitarEar?.available
      ? buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar)
      : buildGuitarTranscription(frames, onsets, contours);
    engine = result.engine;
    notes = result.notes.map(note => ({ ...note, name: midiName(note.midi) }));
    summary = {
      ...result.summary,
      ...(guitarEar?.available ? {} : { guitarEar: guitarEar || { available: false } }),
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
  }

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

function compactGuitarEar(summary) {
  const guitarEar = summary?.guitarEar || {};
  const gate = summary?.guitarEarGate || {};
  if (!Object.keys(guitarEar).length && !Object.keys(gate).length) return null;
  return {
    available: guitarEar.available ?? null,
    device: guitarEar.device ?? null,
    model: guitarEar.model ?? null,
    mean_presence: guitarEar.meanPresence ?? null,
    active_fraction: guitarEar.activeFraction ?? null,
    attack_count: guitarEar.attackCount ?? null,
    active_intervals: guitarEar.activeIntervals || [],
    gate
  };
}

async function saveDiagnostic(result) {
  if (!result.benchmark) return { status: null, error: 'no-benchmark-metadata' };

  const s = result.summary || {};
  const row = {
    user_id: null,
    youtube_video_id: result.benchmark.videoId || null,
    youtube_url: result.benchmark.videoUrl || null,
    reference_label: result.benchmark.mode || 'fixed-30s-v1',
    engine: result.engine || 'unknown',
    instrument: result.instrument,
    track_title: result.title,
    source: 'chrome-extension',
    duration_seconds: result.duration_seconds,
    raw_strict: s.rawByPass?.strict ?? null,
    raw_balanced: s.rawByPass?.balanced ?? null,
    raw_sensitive: s.rawByPass?.sensitive ?? null,
    merged_candidates: s.mergedCandidates ?? null,
    teaching_candidates: s.teachingCandidates ?? null,
    rejected_as_noise: s.rejectedAsNoise ?? null,
    sensitive_only: s.sensitiveOnly ?? null,
    playable_notes: s.playableNotes ?? result.notes?.length ?? null,
    onset_groups: s.onsetGroups ?? null,
    high_confidence: s.highConfidence ?? null,
    uncertain: s.uncertain ?? null,
    average_confidence: s.averageConfidence ?? null,
    playable_notes_per_second: s.playablePerSecond ?? perSecond(result.notes?.length || 0, result.duration_seconds),
    browser_user_agent: navigator.userAgent,
    extra: {
      benchmark_mode: result.benchmark.mode,
      start_seconds: result.benchmark.startSeconds,
      end_seconds: result.benchmark.endSeconds,
      requested_duration_seconds: result.benchmark.requestedDurationSeconds,
      local_browser_analysis: true,
      audio_uploaded: false,
      local_audio_retained: true,
      guitar_ear: compactGuitarEar(s)
    }
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/transcription_diagnostics`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });

    if (!response.ok) {
      const message = await response.text();
      console.warn('Diagnostic upload failed', response.status, message);
      return { status: response.status, error: message || `HTTP ${response.status}` };
    }

    return { status: response.status, error: null };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn('Diagnostic upload failed', error);
    return { status: 0, error: message };
  }
}

async function endRecording() {
  if (!recorder || recorder.state !== 'recording') throw new Error('No active recording.');

  const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.stop();
  await stopped;

  mediaStream?.getTracks().forEach(track => track.stop());
  await audioContext?.close();

  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  const result = await analyseBlob(blob);
  const diagnostic = await saveDiagnostic(result);
  result.diagnostic = {
    supabase_status: diagnostic.status,
    supabase_error: diagnostic.error,
    uploader: 'offscreen-phase2d'
  };

  const localResult = {
    ...result,
    captured_audio_blob: blob,
    captured_audio_mime_type: blob.type || 'audio/webm',
    captured_audio_size_bytes: blob.size,
    captured_audio_local_only: true
  };
  await saveAnalysisResult(localResult);
  await chrome.runtime.sendMessage({ type: 'ANALYSIS_READY', result });

  chunks = [];
  recorder = null;
  mediaStream = null;
  audioContext = null;
  captureMeta = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  (async () => {
    if (message.type === 'BEGIN_RECORDING') await beginRecording(message);
    else if (message.type === 'END_RECORDING') await endRecording();
    sendResponse({ ok: true });
  })().catch(async error => {
    await chrome.runtime.sendMessage({ type: 'ANALYSIS_ERROR', error: error.message || String(error) });
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});
