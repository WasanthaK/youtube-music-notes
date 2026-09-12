const ORIGINAL_AUDIO_DB_NAME = 'youtube-music-notes-extension';
const ORIGINAL_AUDIO_STORE_NAME = 'analysis';

let originalAudioUrl = null;
let originalStopAt = null;

function openOriginalAudioDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ORIGINAL_AUDIO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ORIGINAL_AUDIO_STORE_NAME)) {
        request.result.createObjectStore(ORIGINAL_AUDIO_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadOriginalAudioResult() {
  const db = await openOriginalAudioDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ORIGINAL_AUDIO_STORE_NAME, 'readonly');
      const request = tx.objectStore(ORIGINAL_AUDIO_STORE_NAME).get('latest');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function safeFilePart(value) {
  return String(value || 'captured-sample')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'captured-sample';
}

function audioExtension(mime) {
  if (String(mime).includes('ogg')) return 'ogg';
  if (String(mime).includes('mp4')) return 'm4a';
  return 'webm';
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function stopOriginalAudio(reset = false) {
  const audio = document.querySelector('#capturedOriginalAudio');
  if (!audio) return;
  audio.pause();
  originalStopAt = null;
  if (reset) audio.currentTime = 0;
  document.querySelector('#originalAudioStatus').textContent = 'Original capture ready.';
}

async function playOriginalAudio(rate = 1, firstSeconds = null) {
  const audio = document.querySelector('#capturedOriginalAudio');
  if (!audio?.src) return;
  audio.pause();
  audio.currentTime = 0;
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  audio.volume = 1;
  originalStopAt = firstSeconds ? Math.min(firstSeconds, Number.isFinite(audio.duration) ? audio.duration : firstSeconds) : null;
  const label = firstSeconds ? `first ${firstSeconds} seconds` : 'full capture';
  document.querySelector('#originalAudioStatus').textContent = `Playing ${label} at ${rate.toFixed(2)}× from the exact captured audio…`;
  await audio.play();
}

async function initOriginalAudio() {
  const card = document.querySelector('#originalAudioCard');
  const status = document.querySelector('#originalAudioStatus');
  const audio = document.querySelector('#capturedOriginalAudio');
  if (!card || !status || !audio) return;

  try {
    const result = await loadOriginalAudioResult();
    const blob = result?.captured_audio_blob;
    if (!(blob instanceof Blob) || blob.size === 0) {
      status.textContent = 'This result was created before local audio retention was enabled. Run a new transcription to capture the original 30-second sample.';
      document.querySelectorAll('[data-original-audio-control]').forEach(el => { el.disabled = true; });
      audio.hidden = true;
      return;
    }

    originalAudioUrl = URL.createObjectURL(blob);
    audio.src = originalAudioUrl;
    audio.hidden = false;
    audio.volume = 1;

    const meta = document.querySelector('#originalAudioMeta');
    const size = formatBytes(result.captured_audio_size_bytes || blob.size);
    const mime = result.captured_audio_mime_type || blob.type || 'audio/webm';
    meta.textContent = `${result.duration_seconds?.toFixed?.(1) || '30'} sec local capture${size ? ` · ${size}` : ''} · ${mime}. Kept only in this extension's local IndexedDB.`;

    document.querySelector('#playOriginalTen').addEventListener('click', () => playOriginalAudio(1, 10));
    document.querySelector('#playOriginalTenSlow').addEventListener('click', () => playOriginalAudio(0.75, 10));
    document.querySelector('#stopOriginalAudio').addEventListener('click', () => stopOriginalAudio(false));
    document.querySelector('#downloadOriginalAudio').addEventListener('click', () => {
      const a = document.createElement('a');
      const id = result.benchmark?.videoId || result.title || 'captured-sample';
      a.href = originalAudioUrl;
      a.download = `${safeFilePart(id)}.${audioExtension(mime)}`;
      a.click();
    });

    audio.addEventListener('timeupdate', () => {
      if (originalStopAt != null && audio.currentTime >= originalStopAt) {
        audio.pause();
        originalStopAt = null;
        status.textContent = 'Original 10-second comparison finished.';
      }
    });
    audio.addEventListener('ended', () => {
      originalStopAt = null;
      status.textContent = 'Original capture finished.';
    });
    status.textContent = 'Original capture ready. Compare this directly with the detected-guitar playback below.';
  } catch (error) {
    status.textContent = `Could not load captured original audio: ${error?.message || error}`;
  }
}

window.addEventListener('beforeunload', () => {
  if (originalAudioUrl) URL.revokeObjectURL(originalAudioUrl);
});

void initOriginalAudio();
