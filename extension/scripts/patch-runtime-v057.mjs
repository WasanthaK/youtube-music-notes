import fs from 'node:fs';

const path = 'service_worker.js';
let text = fs.readFileSync(path, 'utf8');

function replace(from, to, label) {
  if (!text.includes(from)) throw new Error(`missing ${label}`);
  text = text.replace(from, to);
}

replace(
  'async function ensureOffscreen() {',
  `async function resetOffscreenForCapture() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some(c => c.documentUrl.endsWith(OFFSCREEN_URL))) {
    await chrome.offscreen.closeDocument();
    await sleep(120);
  }
  await ensureOffscreen();
}

async function ensureOffscreen() {`,
  'ensureOffscreen function',
);

replace(
  'async function waitForYouTubeMediaTime(tabId, endSeconds) {',
  'async function waitForYouTubeMediaTime(tabId, endSeconds, segmentSeconds) {',
  'waitForYouTubeMediaTime signature',
);

replace(
  '    func: async end => {',
  '    func: async (end, segmentDuration) => {',
  'end watcher function args',
);

replace(
  '        }, 60000);',
  '        }, Math.ceil((segmentDuration + 15) * 1000));',
  'fixed 60 second watcher timeout',
);

replace(
  '    args: [endSeconds]',
  '    args: [endSeconds, segmentSeconds]',
  'end watcher injected args',
);

replace(
  '      await ensureOffscreen();\n      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });',
  '      // Always start captures with a fresh offscreen document so an extension\n      // reload cannot leave an older transcription bundle alive in Chrome.\n      await resetOffscreenForCapture();\n      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });',
  'fresh offscreen before segment capture',
);

replace(
  '      const endWatcher = waitForYouTubeMediaTime(tab.id, endSeconds);',
  '      const endWatcher = waitForYouTubeMediaTime(tab.id, endSeconds, segmentSeconds);',
  'end watcher call',
);

text = `// runtime-refresh-v057\n${text}`;
fs.writeFileSync(path, text);
console.log('RUNTIME_V057_PATCH_OK fresh-offscreen scalable-media-time-timeout');
