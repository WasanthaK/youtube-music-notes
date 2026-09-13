const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';

let recorder = null;
let chunks = [];
let mediaStream = null;
let audioContext = null;
let captureMeta = null;

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

async function reportProgress(captureMessage) {
  try {
    await chrome.runtime.sendMessage({ type: 'ANALYSIS_PROGRESS', captureMessage });
  } catch {}
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
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(1000);
}

async function endRecording() {
  if (!recorder || recorder.state !== 'recording') throw new Error('No active recording.');

  const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.stop();
  await stopped;

  mediaStream?.getTracks().forEach(t => t.stop());
  await audioContext?.close();

  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  const form = new FormData();
  form.append('audio', blob, 'capture.webm');
  form.append('instrument', captureMeta.instrument);
  form.append('mode', captureMeta.mode);
  form.append('title', captureMeta.title || 'Captured audio');

  if (captureMeta.videoId) form.append('youtube_video_id', captureMeta.videoId);
  if (captureMeta.videoUrl) form.append('youtube_url', captureMeta.videoUrl);
  if (Number.isFinite(captureMeta.startSeconds)) form.append('start_seconds', String(captureMeta.startSeconds));
  if (Number.isFinite(captureMeta.endSeconds)) form.append('end_seconds', String(captureMeta.endSeconds));
  if (Number.isFinite(captureMeta.requestedDurationSeconds)) form.append('requested_duration_seconds', String(captureMeta.requestedDurationSeconds));

  await reportProgress('Sending captured audio to Guitar Ear Phase-2d…');

  let response;
  try {
    response = await fetch('http://127.0.0.1:8765/transcribe', { method: 'POST', body: form });
  } catch (error) {
    throw new Error(`Cannot reach the local Guitar Ear backend at 127.0.0.1:8765. Start the backend and verify its /health endpoint. ${error?.message || error}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Transcription server returned ${response.status}: ${body.slice(0, 240)}`);
  }

  const backendResult = await response.json();
  const result = {
    ...backendResult,
    benchmark: backendResult.benchmark || (captureMeta.videoId ? {
      videoId: captureMeta.videoId,
      videoUrl: captureMeta.videoUrl,
      startSeconds: captureMeta.startSeconds,
      endSeconds: captureMeta.endSeconds,
      requestedDurationSeconds: captureMeta.requestedDurationSeconds
    } : null)
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
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'BEGIN_RECORDING') await beginRecording(message);
    else if (message.type === 'END_RECORDING') await endRecording();
    sendResponse({ ok: true });
  })().catch(async err => {
    await chrome.runtime.sendMessage({ type: 'ANALYSIS_ERROR', error: err.message || String(err) });
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});
