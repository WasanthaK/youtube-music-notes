// Popup: docs/UX_SPEC.md §5 (layout, states), §7.3 (live regions, progress labels).
import {
  CAPTURE_LENGTHS,
  DEFAULT_CAPTURE_SECONDS,
  doneStatusText,
  formatClock,
  planCurrentCapture,
  recordingProgress,
} from './popup-progress.js';

const captureBtn = document.querySelector('#capture');
const stopBtn = document.querySelector('#stop');
const openResultBtn = document.querySelector('#openResult');
const newCaptureBtn = document.querySelector('#newCapture');
const benchmarkBtn = document.querySelector('#benchmark');
const statusEl = document.querySelector('#status');
const errorEl = document.querySelector('#error');
const progressEl = document.querySelector('#progress');
const previewEl = document.querySelector('#preview');
const instrumentEl = document.querySelector('#instrument');
const lengthInputs = [...document.querySelectorAll('input[name="captureSeconds"]')];
const shareDiagnosticsEl = document.querySelector('#shareDiagnostics');
const sharingSummaryEl = document.querySelector('#sharingSummary');

// The fixed benchmark (Advanced) keeps the exact v0.5.x request so new runs compare with existing data.
const BENCHMARK_START_SECONDS = 0;
const BENCHMARK_END_SECONDS = 90;
const CAPTURE_MODE = 'transcribe'; // Mode dropdown removed (spec F9 / Q4); pipeline.js default.

let worker = { captureState: 'idle', captureMessage: 'Ready.' };
let position = null; // last GET_VIDEO_POSITION answer
let pending = false; // a START request is in flight
let pendingText = '';
let doneDismissed = false;
let positionTimer = null;
let recordingTimer = null;

function selectedLength() {
  const checked = lengthInputs.find(input => input.checked);
  const value = Number(checked?.value);
  return CAPTURE_LENGTHS.includes(value) ? value : DEFAULT_CAPTURE_SECONDS;
}

function viewState() {
  const state = worker.captureState;
  if (state === 'recording' || state === 'analysing') return state;
  if (state === 'done' && !doneDismissed) return 'done';
  if (state === 'error') return 'error';
  return position?.ok ? 'ready' : 'unavailable';
}

function currentPlan() {
  if (!position?.ok) return null;
  return planCurrentCapture(position.currentTime, position.duration, selectedLength());
}

function setInputsDisabled(disabled) {
  instrumentEl.disabled = disabled;
  for (const input of lengthInputs) input.disabled = disabled;
  shareDiagnosticsEl.disabled = disabled;
}

function showStatus(text) {
  errorEl.hidden = true;
  errorEl.textContent = '';
  statusEl.textContent = text;
}

function showError(text) {
  statusEl.textContent = '';
  errorEl.textContent = text;
  errorEl.hidden = false;
}

function showProgress(value, label, valueText) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    progressEl.removeAttribute('value'); // indeterminate
  } else {
    progressEl.value = Math.max(0, Math.min(1, Number(value)));
  }
  progressEl.setAttribute('aria-label', label);
  progressEl.setAttribute('aria-valuetext', valueText);
  progressEl.hidden = false;
}

function hideProgress() {
  progressEl.hidden = true;
  progressEl.removeAttribute('aria-valuetext');
}

function renderPreview() {
  const plan = currentPlan();
  if (!position?.ok) {
    previewEl.textContent = '';
    captureBtn.textContent = `Capture ${selectedLength()} s`;
    return plan;
  }
  if (!plan.ok) {
    previewEl.textContent = plan.error;
    captureBtn.textContent = `Capture ${selectedLength()} s from ${formatClock(position.currentTime)}`;
    return plan;
  }
  previewEl.textContent = `From ${formatClock(plan.startSeconds)} to ${formatClock(plan.endSeconds)} in this video`;
  captureBtn.textContent = `Capture ${Math.round(plan.segmentSeconds)} s from ${formatClock(plan.startSeconds)}`;
  return plan;
}

function render() {
  const view = viewState();
  document.body.dataset.state = view;
  const busy = view === 'recording' || view === 'analysing';
  const plan = busy ? null : renderPreview();
  previewEl.hidden = busy || view === 'done';

  captureBtn.hidden = busy || view === 'done';
  stopBtn.hidden = view !== 'recording';
  openResultBtn.hidden = view !== 'done';
  newCaptureBtn.hidden = view !== 'done';

  setInputsDisabled(busy || pending);
  const canCapture = !pending && position?.ok === true && plan?.ok === true;
  captureBtn.disabled = !canCapture;
  benchmarkBtn.disabled = busy || pending || position?.ok !== true;

  if (view === 'recording') {
    const segment = Number(worker.segmentSeconds);
    const { elapsedSeconds, value } = recordingProgress(worker.captureStartedAt, segment, Date.now());
    const of = Number.isFinite(segment) && segment > 0 ? ` of ${formatClock(segment)}` : '';
    showStatus(`Recording ${formatClock(elapsedSeconds)}${of}. Keep the video tab playing. You can close this popup.`);
    if (value === null) hideProgress();
    else showProgress(value, 'Recording progress', `${Math.floor(elapsedSeconds)} of ${Math.round(segment)} seconds`);
  } else if (view === 'analysing') {
    const stage = worker.stage || 'starting';
    showStatus(`Analysing in Chrome: ${stage}.`);
    showProgress(worker.progress, 'Analysis progress', stage.replace(/ %$/, ' percent'));
  } else if (view === 'done') {
    showStatus(doneStatusText(worker.noteCount, worker.captureMessage));
    hideProgress();
  } else if (view === 'error') {
    showError(worker.captureMessage || 'Something went wrong.');
    captureBtn.textContent = 'Try again';
    hideProgress();
  } else if (pending) {
    showStatus(pendingText);
    hideProgress();
  } else if (view === 'unavailable') {
    showStatus('Open a YouTube video to start.');
    hideProgress();
  } else {
    showStatus('Ready.');
    hideProgress();
  }

  scheduleTimers(view);
}

function scheduleTimers(view) {
  const wantsPosition = view === 'ready' || view === 'unavailable' || view === 'error';
  if (wantsPosition && !positionTimer) positionTimer = setInterval(refreshPosition, 1000);
  if (!wantsPosition && positionTimer) { clearInterval(positionTimer); positionTimer = null; }

  const wantsClock = view === 'recording';
  if (wantsClock && !recordingTimer) recordingTimer = setInterval(render, 500);
  if (!wantsClock && recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
}

function applyWorkerState(payload) {
  if (!payload) return;
  const previous = worker.captureState;
  worker = { ...worker, ...payload };
  if (worker.captureState === 'done' && previous !== 'done') doneDismissed = false;
  render();
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    applyWorkerState(response);
  } catch (error) {
    applyWorkerState({ captureState: 'error', captureMessage: error?.message || String(error) });
  }
}

async function refreshPosition() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_POSITION' });
    position = response?.ok ? response : { ok: false };
  } catch {
    position = { ok: false };
  }
  render();
}

async function startCapture(request, text) {
  pending = true;
  pendingText = text;
  doneDismissed = true;
  if (worker.captureState === 'error') worker = { ...worker, captureState: 'idle' };
  render();
  try {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.ok) worker = { ...worker, captureState: 'error', captureMessage: response?.error || 'Could not start the capture.' };
  } catch (error) {
    worker = { ...worker, captureState: 'error', captureMessage: error?.message || String(error) };
  } finally {
    pending = false;
  }
  await refreshState();
}

captureBtn.addEventListener('click', () => {
  void startCapture({
    type: 'START_SEGMENT_CAPTURE',
    instrument: instrumentEl.value,
    mode: CAPTURE_MODE,
    startSeconds: 'current',
    lengthSeconds: selectedLength(),
  }, 'Preparing the capture…');
});

benchmarkBtn.addEventListener('click', () => {
  void startCapture({
    type: 'START_SEGMENT_CAPTURE',
    instrument: instrumentEl.value,
    mode: CAPTURE_MODE,
    startSeconds: BENCHMARK_START_SECONDS,
    endSeconds: BENCHMARK_END_SECONDS,
    benchmarkMode: 'fixed-90s-v1'
  }, 'Rewinding to 0:00 for the benchmark…');
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(error => ({ ok: false, error: error?.message || String(error) }));
  if (!response?.ok) worker = { ...worker, captureState: 'error', captureMessage: response?.error || 'Could not stop capture.' };
  await refreshState();
});

openResultBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_RESULT' }).catch(() => {});
});

newCaptureBtn.addEventListener('click', async () => {
  // Reset the worker too, so reopening the popup shows Ready (RESET_STATE, done/error only).
  doneDismissed = true;
  render();
  captureBtn.focus();
  const response = await chrome.runtime.sendMessage({ type: 'RESET_STATE' }).catch(() => null);
  if (response?.captureState) applyWorkerState(response);
  void refreshPosition();
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'STATE_CHANGED') applyWorkerState(message);
});

function renderSharing() {
  sharingSummaryEl.textContent = `· sharing ${shareDiagnosticsEl.checked ? 'on' : 'off'}`;
}

instrumentEl.addEventListener('change', () => {
  chrome.storage.local.set({ instrument: instrumentEl.value });
});
for (const input of lengthInputs) {
  input.addEventListener('change', () => {
    chrome.storage.local.set({ captureSeconds: selectedLength() });
    render();
  });
}
shareDiagnosticsEl.addEventListener('change', () => {
  chrome.storage.local.set({ shareDiagnostics: shareDiagnosticsEl.checked });
  renderSharing();
});

async function init() {
  const stored = await chrome.storage.local.get(['instrument', 'captureSeconds', 'shareDiagnostics']).catch(() => ({}));
  if (stored?.instrument === 'guitar' || stored?.instrument === 'flute') instrumentEl.value = stored.instrument;
  const seconds = CAPTURE_LENGTHS.includes(Number(stored?.captureSeconds)) ? Number(stored.captureSeconds) : DEFAULT_CAPTURE_SECONDS;
  for (const input of lengthInputs) input.checked = Number(input.value) === seconds;
  shareDiagnosticsEl.checked = stored?.shareDiagnostics === true;
  renderSharing();
  await Promise.all([refreshState(), refreshPosition()]);
}

void init();
