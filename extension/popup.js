const startBtn = document.querySelector('#start');
const stopBtn = document.querySelector('#stop');
const statusEl = document.querySelector('#status');
const instrumentEl = document.querySelector('#instrument');
const modeEl = document.querySelector('#mode');

const BENCHMARK_START_SECONDS = 30;
const BENCHMARK_END_SECONDS = 60;

async function refreshState() {
  const { captureState = 'idle', captureMessage = 'Ready.' } = await chrome.storage.local.get(['captureState', 'captureMessage']);
  statusEl.textContent = captureMessage;
  startBtn.disabled = captureState === 'recording' || captureState === 'analysing';
  stopBtn.disabled = captureState !== 'recording';
}

startBtn.addEventListener('click', async () => {
  statusEl.textContent = 'Preparing automatic 0:30 → 1:00 benchmark…';
  const response = await chrome.runtime.sendMessage({
    type: 'START_SEGMENT_CAPTURE',
    instrument: instrumentEl.value,
    mode: modeEl.value,
    startSeconds: BENCHMARK_START_SECONDS,
    endSeconds: BENCHMARK_END_SECONDS,
    benchmarkMode: 'fixed-30s-v1'
  });
  if (!response?.ok) statusEl.textContent = response?.error || 'Could not start benchmark capture.';
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
