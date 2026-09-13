import { uploadDiagnosticFromResult } from './service-worker-diagnostic.js';

const OFFSCREEN_URL = 'offscreen.html';
let autoStopTimer = null;
let captureState = 'idle';
let captureMessage = 'Ready.';
let captureBenchmark = null;
let captureSessionId = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function statePayload() {
  return { captureState, captureMessage };
}

async function setState(state, message) {
  captureState = state;
  captureMessage = message;
  try {
    await chrome.runtime.sendMessage({ type: 'STATE_CHANGED', ...statePayload() });
  } catch {}
}

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
          const timer = setTimeout(() => reject(new Error('Timed out waiting for YouTube video metadata.')), 10000);
          video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }

      video.pause();
      video.playbackRate = 1;

      const seekTo = async target => {
        if (Math.abs(video.currentTime - target) <= 0.08) return;
        await new Promise((resolve, reject) => {
          const onSeeked = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            reject(new Error(`Timed out seeking YouTube video to ${target.toFixed(2)}s.`));
          }, 10000);
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = target;
        });
      };

      await seekTo(start);

      const deadline = performance.now() + 3000;
      while (performance.now() < deadline && Math.abs(video.currentTime - start) > 0.12) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      video.pause();

      if (Math.abs(video.currentTime - start) > 0.15) {
        throw new Error(`YouTube seek verification failed: expected ${start.toFixed(2)}s, got ${video.currentTime.toFixed(2)}s.`);
      }

      return {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        title: document.title,
      };
    },
    args: [startSeconds]
  });
  return result;
}

async function playYouTube(tabId, expectedStartSeconds) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async expectedStart => {
      const video = document.querySelector('video');
      if (!video) throw new Error('No YouTube video element found.');
      video.playbackRate = 1;
      if (Math.abs(video.currentTime - expectedStart) > 0.18) {
        throw new Error(`Capture start drifted before playback: expected ${expectedStart.toFixed(2)}s, got ${video.currentTime.toFixed(2)}s.`);
      }
      await video.play();
      return { currentTime: video.currentTime, paused: video.paused };
    },
    args: [expectedStartSeconds]
  });
  return result;
}

async function waitForYouTubeMediaTime(tabId, endSeconds) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async end => {
      const video = document.querySelector('video');
      if (!video) throw new Error('No YouTube video element found.');

      return await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          video.removeEventListener('timeupdate', check);
          video.removeEventListener('ended', onEnded);
          clearInterval(interval);
          clearTimeout(timeout);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          video.pause();
          cleanup();
          resolve({ currentTime: video.currentTime, reachedEnd: true });
        };
        const check = () => {
          if (video.currentTime >= end - 0.03) finish();
        };
        const onEnded = () => {
          if (video.currentTime >= end - 0.25) finish();
          else {
            cleanup();
            reject(new Error(`YouTube ended at ${video.currentTime.toFixed(2)}s before requested ${end.toFixed(2)}s.`));
          }
        };
        const interval = setInterval(check, 50);
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Timed out waiting for YouTube media time ${end.toFixed(2)}s; current ${video.currentTime.toFixed(2)}s.`));
        }, 60000);
        video.addEventListener('timeupdate', check);
        video.addEventListener('ended', onEnded);
        check();
      });
    },
    args: [endSeconds]
  });
  return result;
}

async function pauseYouTube(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const video = document.querySelector('video');
        if (!video) return null;
        video.pause();
        return { currentTime: video.currentTime };
      }
    });
    return result;
  } catch {
    return null;
  }
}

async function stopCapture(tabId = null, expectedSessionId = null) {
  if (expectedSessionId !== null && expectedSessionId !== captureSessionId) return;
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  const paused = tabId ? await pauseYouTube(tabId) : null;
  if (captureBenchmark && paused?.currentTime !== undefined) {
    captureBenchmark.actualEndSeconds = Number(paused.currentTime);
  }
  await setState('analysing', 'Analysing exact YouTube segment…');
  await ensureOffscreen();
  await sendToOffscreen({ target: 'offscreen', type: 'END_RECORDING' });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'GET_STATE') {
      sendResponse({ ok: true, ...statePayload() });
      return;
    }

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
      if (Math.abs(Number(prepared?.currentTime) - startSeconds) > 0.15 || prepared?.paused !== true) {
        throw new Error(`Could not verify YouTube at ${startSeconds.toFixed(2)}s before capture.`);
      }

      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const segmentSeconds = endSeconds - startSeconds;
      const sessionId = ++captureSessionId;
      captureBenchmark = {
        mode: benchmarkMode,
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        startSeconds,
        endSeconds,
        requestedDurationSeconds: segmentSeconds,
        actualStartSeconds: Number(prepared.currentTime),
      };

      await setState('recording', `Recording YouTube ${videoId}: ${startSeconds.toFixed(1)}s → ${endSeconds.toFixed(1)}s (${segmentSeconds.toFixed(1)}s)…`);

      await sendToOffscreen({
        target: 'offscreen',
        type: 'BEGIN_RECORDING',
        streamId,
        instrument: message.instrument,
        mode: message.mode,
        title: tab.title || prepared?.title || 'Captured audio',
        benchmarkMode,
        videoId,
        videoUrl: captureBenchmark.videoUrl,
        startSeconds,
        endSeconds,
        requestedDurationSeconds: segmentSeconds,
        actualStartSeconds: captureBenchmark.actualStartSeconds,
      });

      const endWatcher = waitForYouTubeMediaTime(tab.id, endSeconds);
      const played = await playYouTube(tab.id, startSeconds);
      captureBenchmark.actualPlaybackStartSeconds = Number(played?.currentTime ?? startSeconds);

      void endWatcher.then(async observed => {
        if (sessionId !== captureSessionId) return;
        if (captureBenchmark) captureBenchmark.actualEndSeconds = Number(observed?.currentTime ?? endSeconds);
        await stopCapture(tab.id, sessionId);
      }).catch(async error => {
        if (sessionId !== captureSessionId) return;
        await setState('error', error?.message || String(error));
        await stopCapture(tab.id, sessionId).catch(() => {});
      });

      // Failure fallback only. Normal stopping is driven by YouTube media time,
      // not a 30-second wall-clock timer, so buffering cannot shift the window.
      autoStopTimer = setTimeout(() => {
        if (sessionId !== captureSessionId) return;
        stopCapture(tab.id, sessionId).catch(err => setState('error', err.message || String(err)));
      }, Math.ceil((segmentSeconds + 15) * 1000));

      sendResponse({ ok: true, ...captureBenchmark });
      return;
    }

    if (message.type === 'START_CAPTURE') {
      const tab = await activeTab();
      captureSessionId += 1;
      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      captureBenchmark = null;
      await setState('recording', 'Recording tab audio… play the section you want.');
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
      captureSessionId += 1;
      await stopCapture(tab?.id || null);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ANALYSIS_PROGRESS') {
      await setState('analysing', message.captureMessage || 'Analysing locally…');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ANALYSIS_READY') {
      const diagnostic = await uploadDiagnosticFromResult(message.result).catch(error => ({
        supabase_status: null,
        supabase_ok: false,
        error: error?.message || String(error),
      }));
      message.result.diagnostic = diagnostic;
      const count = message.result?.notes?.length || 0;
      const uploadNote = diagnostic?.supabase_ok === false ? ' Diagnostic upload will retry from the result page.' : '';
      await setState('done', `Done: ${count} notes detected.${uploadNote}`);
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
      sendResponse({ ok: true, diagnostic });
      return;
    }

    if (message.type === 'ANALYSIS_ERROR') {
      await setState('error', message.error || 'Analysis failed.');
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message.' });
  })().catch(async err => {
    await setState('error', err.message || String(err));
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});