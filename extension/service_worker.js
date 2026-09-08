const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some(c => c.documentUrl.endsWith(OFFSCREEN_URL))) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture the current tab audio after the user starts music transcription.'
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START_CAPTURE') {
      const tab = await activeTab();
      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await chrome.storage.local.set({ captureState: 'recording', captureMessage: 'Recording tab audio… play the section you want.' });
      await chrome.runtime.sendMessage({
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
      await chrome.storage.local.set({ captureState: 'analysing', captureMessage: 'Uploading captured audio to the local transcription engine…' });
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'END_RECORDING' });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'ANALYSIS_READY') {
      await chrome.storage.local.set({
        captureState: 'done',
        captureMessage: `Done: ${message.result.notes?.length || 0} notes detected.`,
        analysisResult: message.result
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
