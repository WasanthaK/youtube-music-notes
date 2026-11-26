import { BasicPitch } from '@spotify/basic-pitch';
import { analyzeGuitarEar } from './guitarEarBrowser.js';
import { transcribeAudio } from './pipeline.js';

const BASIC_PITCH_MODEL_URL = () => chrome.runtime.getURL('dist/models/basic-pitch/model.json');
const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';

let recorder = null;
let chunks = [];
let mediaStream = null;
let audioContext = null;
let captureMeta = null;

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

async function runBasicPitch(audioBuffer) {
  const basicPitch = new BasicPitch(BASIC_PITCH_MODEL_URL());
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

  const basicPitchAudio = await resampleMono(decoded, 22050);
  return await transcribeAudio(
    {
      samples: basicPitchAudio.getChannelData(0),
      sampleRate: basicPitchAudio.sampleRate,
      durationSeconds: basicPitchAudio.duration
    },
    {
      // Basic Pitch is given the original AudioBuffer, exactly as before the extraction;
      // its channel 0 is input.samples.
      runBasicPitch: () => runBasicPitch(basicPitchAudio),
      // Guitar Ear needs a 16 kHz AudioBuffer; it is resampled only when the pipeline asks for it.
      runGuitarEar: async () => analyzeGuitarEar(await resampleMono(decoded, 16000)),
      reportProgress
    },
    captureMeta
  );
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
  // One id per analysis; the service worker is the only primary uploader.
  result.run_id = crypto.randomUUID();

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
