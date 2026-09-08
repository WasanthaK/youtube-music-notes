const OFFSCREEN_URL = 'offscreen.html';
let autoStopTimer = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendToOffscreen(message, attempts = 30, delayMs = 100) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      lastError = error;
      const text = error?.message || String(error);
      if (!text.includes('Receiving end does not exist')) throw error;
      await sleep(delayMs);
    }
  }
  throw new Error(`Offscreen transcription engine did not become ready: ${lastError?.message || lastError || 'unknown error'}`);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.some(c => c.documentUrl.endsWith(OFFSCREEN_URL))) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture the current tab audio after the user starts music transcription.'
    });
  }

  // createDocument() can resolve before the bundle has registered its runtime listener.
  // PING with retry makes capture deterministic instead of racing extension startup.
  await sendToOffscreen({ target: 'offscreen', type: 'PING' });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

function youtubeVideoId(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
    if (parsed.hostname.endsWith('youtube.com')) return parsed.searchParams.get('v');
  } catch {}
  return null;
}

async function prepareYouTubeSegment(tabId, startSeconds) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async start => {
      const video = document.querySelector('video');
      if (!video) throw new Error('No YouTube video element found on this page.');

      if (video.readyState < 1) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out waiting for YouTube video metadata.')), 8000);
          video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }

      video.pause();
      video.playbackRate = 1;

      if (Math.abs(video.currentTime - start) > 0.2) {
        video.currentTime = start;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out seeking YouTube video.')), 8000);
          video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }

      return {
        currentTime: video.currentTime,
        duration: video.duration,
        title: document.title
      };
    },
    args: [startSeconds]
  });

  return result;
}

async function playYouTube(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const video = document.querySelector('video');
      if (!video) throw new Error('No YouTube video element found.');
      video.playbackRate = 1;
      await video.play();
      return video.currentTime;
    }
  });
}

async function pauseYouTube(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        if (video) video.pause();
      }
    });
  } catch {}
}

async function stopCapture(tabId = null) {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  if (tabId) await pauseYouTube(tabId);
  await chrome.storage.local.set({ captureState: 'analysing', captureMessage: 'Analysing exact YouTube segment…' });
  await ensureOffscreen();
  await sendToOffscreen({ target: 'offscreen', type: 'END_RECORDING' });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START_SEGMENT_CAPTURE') {
      const tab = await activeTab();
      const videoId = youtubeVideoId(tab.url || '');
      if (!videoId) throw new Error('Open a YouTube video page before starting an exact segment capture.');

      const startSeconds = Number(message.startSeconds);
      const endSeconds = Number(message.endSeconds);
      const benchmarkMode = message.benchmarkMode || 'manual-segment';
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
        throw new Error('Invalid start/end time range.');
      }

      const prepared = await prepareYouTubeSegment(tab.id, startSeconds);
      if (Number.isFinite(prepared?.duration) && endSeconds > prepared.duration + 0.25) {
        throw new Error(`End time exceeds this video's duration (${prepared.duration.toFixed(1)}s).`);
      }

      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const segmentSeconds = endSeconds - startSeconds;
      const benchmark = {
        mode: benchmarkMode,
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        startSeconds,
        endSeconds,
        requestedDurationSeconds: segmentSeconds
      };

      await chrome.storage.local.set({
        captureState: 'recording',
        captureMessage: `Recording YouTube ${videoId}: ${startSeconds.toFixed(1)}s → ${endSeconds.toFixed(1)}s (${segmentSeconds.toFixed(1)}s)…`,
        captureBenchmark: benchmark
      });

      await sendToOffscreen({
        target: 'offscreen',
        type: 'BEGIN_RECORDING',
        streamId,
        instrument: message.instrument,
        mode: message.mode,
        title: tab.title || prepared?.title || 'Captured audio',
        benchmarkMode,
        videoId,
        videoUrl: benchmark.videoUrl,
        startSeconds,
        endSeconds,
        requestedDurationSeconds: segmentSeconds
      });

      await playYouTube(tab.id);

      autoStopTimer = setTimeout(() => {
        stopCapture(tab.id).catch(async err => {
          await chrome.storage.local.set({ captureState: 'error', captureMessage: err.message || String(err) });
        });
      }, Math.ceil(segmentSeconds * 1000));

      sendResponse({ ok: true, ...benchmark });
      return;
    }

    if (message.type === 'START_CAPTURE') {
      const tab = await activeTab();
      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await chrome.storage.local.set({ captureState: 'recording', captureMessage: 'Recording tab audio… play the section you want.' });
      await sendToOffscreen({
        target: 'offscreen',
        type: 'BEGIN_RECORDING',
        streamId,
        instrument: message.instrument,
        mode: message.mode,
        title: tab.title || 'Captured audio'
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'STOP_CAPTURE') {
      const tab = await activeTab().catch(() => null);
      await stopCapture(tab?.id || null);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ANALYSIS_READY') {
      const { captureBenchmark = null } = await chrome.storage.local.get('captureBenchmark');
      await chrome.storage.local.set({
        captureState: 'done',
        captureMessage: `Done: ${message.result.notes?.length || 0} notes detected.`,
        analysisResult: {
          ...message.result,
          benchmark: captureBenchmark || message.result.benchmark || null
        }
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ANALYSIS_ERROR') {
      await chrome.storage.local.set({ captureState: 'error', captureMessage: message.error || 'Analysis failed.' });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message.' });
  })().catch(async (err) => {
    await chrome.storage.local.set({ captureState: 'error', captureMessage: err.message || String(err) });
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});
