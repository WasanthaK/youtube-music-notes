const startBtn = document.querySelector('#start');
const stopBtn = document.querySelector('#stop');
const statusEl = document.querySelector('#status');
const instrumentEl = document.querySelector('#instrument');
const modeEl = document.querySelector('#mode');
const startTimeEl = document.querySelector('#startTime');
const endTimeEl = document.querySelector('#endTime');

function parseTime(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function refreshState() {
  const { captureState = 'idle', captureMessage = 'Ready.' } = await chrome.storage.local.get(['captureState', 'captureMessage']);
  statusEl.textContent = captureMessage;
  startBtn.disabled = captureState === 'recording' || captureState === 'analysing';
  stopBtn.disabled = captureState !== 'recording';
}

startBtn.addEventListener('click', async () => {
  const startSeconds = parseTime(startTimeEl.value);
  const endSeconds = parseTime(endTimeEl.value);

  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
    statusEl.textContent = 'Enter a valid start and end, for example 0:30 to 1:15.';
    return;
  }

  statusEl.textContent = `Preparing ${startTimeEl.value} → ${endTimeEl.value}…`;
  const response = await chrome.runtime.sendMessage({
    type: 'START_SEGMENT_CAPTURE',
    instrument: instrumentEl.value,
    mode: modeEl.value,
    startSeconds,
    endSeconds
  });
  if (!response?.ok) statusEl.textContent = response?.error || 'Could not start segment capture.';
  await refreshState();
});

stopBtn.addEventListener('click', async () => {
  statusEl.textContent = 'Stopping and analysing…';
  const response = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  if (!response?.ok) statusEl.textContent = response?.error || 'Could not stop capture.';
  await refreshState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.captureState || changes.captureMessage)) refreshState();
});

refreshState();
