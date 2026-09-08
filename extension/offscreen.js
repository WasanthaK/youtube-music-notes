let recorder = null;
let chunks = [];
let mediaStream = null;
let audioContext = null;
let captureMeta = null;

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

  const response = await fetch('http://127.0.0.1:8765/transcribe', { method: 'POST', body: form });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Transcription server returned ${response.status}: ${body.slice(0, 240)}`);
  }

  const result = await response.json();
  await chrome.runtime.sendMessage({
    type: 'ANALYSIS_READY',
    result: {
      ...result,
      benchmark: captureMeta.videoId ? {
        videoId: captureMeta.videoId,
        videoUrl: captureMeta.videoUrl,
        startSeconds: captureMeta.startSeconds,
        endSeconds: captureMeta.endSeconds,
        requestedDurationSeconds: captureMeta.requestedDurationSeconds
      } : null
    }
  });

  chunks = [];
  recorder = null;
  mediaStream = null;
  audioContext = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  (async () => {
    if (message.type === 'BEGIN_RECORDING') await beginRecording(message);
    else if (message.type === 'END_RECORDING') await endRecording();
    sendResponse({ ok: true });
  })().catch(async err => {
    await chrome.runtime.sendMessage({ type: 'ANALYSIS_ERROR', error: err.message || String(err) });
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});
