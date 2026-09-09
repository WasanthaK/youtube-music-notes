import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { buildGuitarTranscription } from './guitarEngine.js';

const MODEL_URL = 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json';
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
  const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.start(1000);
}

async function decodeToMono22050(blob) {
  const ctx = new AudioContext();
  try {
    const input = await ctx.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(input.duration * 22050), 22050);
    const source = offline.createBufferSource();
    source.buffer = input;
    source.connect(offline.destination);
    source.start();
    return await offline.startRendering();
  } finally {
    await ctx.close();
  }
}

function reduceMelody(notes, minMidi, maxMidi) {
  const filtered = notes
    .filter(n => n.midi >= minMidi && n.midi <= maxMidi && n.confidence >= 0.18)
    .sort((a,b) => a.start - b.start || b.midi - a.midi);
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
  const raw = timed.map(n => ({
    start: n.startTimeSeconds,
    end: n.startTimeSeconds + n.durationSeconds,
    midi: n.pitchMidi,
    confidence: n.amplitude,
    name: midiName(n.pitchMidi)
  }));
  const notes = reduceMelody(raw, 60, 96);
  return { notes, summary: { rawCount: raw.length, playableNotes: notes.length } };
}

async function analyseBlob(blob) {
  const audioBuffer = await decodeToMono22050(blob);
  const basicPitch = new BasicPitch(MODEL_URL);
  const frames = [];
  const onsets = [];
  const contours = [];

  await reportProgress('Analysing 30-second sample locally in Chrome…');

  await basicPitch.evaluateModel(
    audioBuffer,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    progress => {
      const pct = Math.round(progress * 100);
      void reportProgress(`Analysing locally… ${pct}%`);
    }
  );

  const instrument = captureMeta.instrument || 'guitar';
  const duration = audioBuffer.duration;
  let notes;
  let summary;
  let engine;

  if (instrument === 'guitar') {
    const result = buildGuitarTranscription(frames, onsets, contours);
    engine = result.engine;
    notes = result.notes.map(note => ({ ...note, name: midiName(note.midi) }));
    summary = {
      ...result.summary,
      durationSeconds: duration,
      mergedPerSecond: perSecond(result.summary.mergedCandidates, duration),
      teachingPerSecond: perSecond(result.summary.teachingCandidates, duration),
      playablePerSecond: perSecond(result.summary.playableNotes, duration),
      onsetGroupsPerSecond: perSecond(result.summary.onsetGroups, duration)
    };
  } else {
    const result = buildFluteTranscription(frames, onsets, contours);
    engine = 'flute-basic-pitch-browser-v1';
    notes = result.notes;
    summary = { ...result.summary, durationSeconds: duration };
  }

  return {
    title: captureMeta.title || 'Captured audio',
    instrument,
    mode: captureMeta.mode || 'transcribe',
    duration_seconds: duration,
    notes,
    warnings: ['Automatic transcription is approximate on dense full mixes.'],
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

async function saveDiagnostic(result) {
  if (!result.benchmark) return;
  const s = result.summary || {};
  const row = {
    user_id: null,
    youtube_video_id: result.benchmark.videoId || null,
    youtube_url: result.benchmark.videoUrl || null,
    reference_label: result.benchmark.mode || 'fixed-30s-v1',
    engine: result.engine || 'unknown',
    instrument: result.instrument,
    track_title: result.title,
    source: 'chrome-extension-browser',
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
      audio_uploaded: false
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
    if (!response.ok) console.warn('Diagnostic upload failed', response.status, await response.text());
  } catch (error) {
    console.warn('Diagnostic upload failed', error);
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
  await saveAnalysisResult(result);
  await saveDiagnostic(result);
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
