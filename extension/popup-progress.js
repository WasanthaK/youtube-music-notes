// Pure helpers shared by service_worker.js (ES module), popup.js (ES module) and
// scripts/test-popup-progress.mjs (Node). No chrome.*, DOM or timers here.
// Spec: docs/UX_SPEC.md §5.2 (analysis progress table) and §5.3 (capture from current position).

export const MIN_REMAINING_SECONDS = 5;
export const TOO_LITTLE_LEFT_MESSAGE = 'Less than 5 seconds left in this video.';
export const CAPTURE_LENGTHS = [30, 60, 90];
export const DEFAULT_CAPTURE_SECONDS = 90;

// The Basic Pitch progress line is `Basic Pitch in Chrome… 55%` today; the
// pattern also accepts wording without "in Chrome".
const BASIC_PITCH_PERCENT = /Basic Pitch[^0-9]*?(\d+)%/;

const PREFIX_STAGES = [
  ['Analysing exact YouTube segment', 0.01, 'starting'],
  ['Decoding captured audio', 0.03, 'decoding audio'],
  ['Learning tempo', 0.08, 'finding the beat'],
  ['Guitar Ear', 0.15, 'listening for guitar'],
  ['Transcribing locally with Basic Pitch', 0.30, 'detecting notes'],
];

/**
 * Maps an analysis captureMessage to { progress, stage }.
 * Unknown messages keep the previous values (`previous` may be null).
 */
export function analysisProgress(captureMessage, previous = null) {
  const keep = { progress: previous?.progress ?? null, stage: previous?.stage ?? null };
  const text = String(captureMessage ?? '').trim();
  if (!text) return keep;

  const percent = BASIC_PITCH_PERCENT.exec(text);
  if (percent) {
    const n = Math.max(0, Math.min(100, Number(percent[1])));
    return { progress: round4(0.30 + 0.65 * n / 100), stage: `detecting notes ${n} %` };
  }
  for (const [prefix, progress, stage] of PREFIX_STAGES) {
    if (text.startsWith(prefix)) return { progress, stage };
  }
  return keep;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** Rounds a video time down to 0.1 s (robust to float error such as 2.3 * 10 = 22.999…). */
export function roundDownToTenth(seconds) {
  return Math.floor(Number(seconds) * 10 + 1e-6) / 10;
}

/**
 * Plans a capture that starts at the video's current position.
 * Returns { ok: true, startSeconds, endSeconds, segmentSeconds } or { ok: false, error }.
 * A non-finite duration (unknown or live) does not clamp the end.
 */
export function planCurrentCapture(currentTime, duration, lengthSeconds) {
  const now = Number(currentTime);
  const length = Number(lengthSeconds);
  if (!Number.isFinite(now) || now < 0) return { ok: false, error: 'Could not read the video position.' };
  if (!Number.isFinite(length) || length <= 0) return { ok: false, error: 'Invalid capture length.' };

  const startSeconds = roundDownToTenth(now);
  const total = Number(duration);
  const knownDuration = Number.isFinite(total) && total > 0;
  if (knownDuration && total - startSeconds < MIN_REMAINING_SECONDS) {
    return { ok: false, error: TOO_LITTLE_LEFT_MESSAGE };
  }
  const endSeconds = round3(knownDuration ? Math.min(startSeconds + length, total) : startSeconds + length);
  return { ok: true, startSeconds, endSeconds, segmentSeconds: round3(endSeconds - startSeconds) };
}

export const NO_SEEK_TOLERANCE_SECONDS = 0.1;

/**
 * Final range once the video is paused. Planned start = round-down to 0.1 s; when the real
 * position is within 0.1 s of it there is no seek, and the real position (to 1 ms) is the start,
 * so benchmark.startSeconds matches what was recorded. Returns planCurrentCapture's shape plus `seek`.
 */
export function settleCurrentCapture(currentTime, duration, lengthSeconds, tolerance = NO_SEEK_TOLERANCE_SECONDS) {
  const plan = planCurrentCapture(currentTime, duration, lengthSeconds);
  if (!plan.ok) return plan;
  const actual = round3(Number(currentTime));
  if (Math.abs(actual - plan.startSeconds) > tolerance) return { ...plan, seek: true };
  const total = Number(duration);
  const knownDuration = Number.isFinite(total) && total > 0;
  const length = Number(lengthSeconds);
  const endSeconds = round3(knownDuration ? Math.min(actual + length, total) : actual + length);
  if (knownDuration && total - actual < MIN_REMAINING_SECONDS) return { ok: false, error: TOO_LITTLE_LEFT_MESSAGE };
  return { ok: true, startSeconds: actual, endSeconds, segmentSeconds: round3(endSeconds - actual), seek: false };
}

/** RESET_STATE is allowed only from a finished or failed capture. */
export function canResetState(captureState) {
  return captureState === 'done' || captureState === 'error';
}

/** Popup text for the done state; keeps the worker's diagnostic-retry sentence when present. */
export function doneStatusText(noteCount, captureMessage = '') {
  const message = String(captureMessage ?? '');
  const parsed = /Done:\s*(\d+)/.exec(message);
  const count = noteCount !== null && noteCount !== undefined && Number.isFinite(Number(noteCount))
    ? Number(noteCount)
    : Number(parsed?.[1] ?? 0);
  const retry = /Diagnostic upload will retry[^.]*\./.exec(message);
  return `Done: ${count} notes. The result is open in its own tab.${retry ? ` ${retry[0]}` : ''}`;
}

/** 83.7 → "1:23"; 3725 → "1:02:05". Floors to whole seconds. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Recording progress for the popup: elapsed seconds (capped at the segment) and a 0–0.99 value. */
export function recordingProgress(captureStartedAt, segmentSeconds, nowMs) {
  const segment = Number(segmentSeconds);
  const started = Number(captureStartedAt);
  const elapsedRaw = Number.isFinite(started) && started > 0 ? Math.max(0, (Number(nowMs) - started) / 1000) : 0;
  if (!Number.isFinite(segment) || segment <= 0) return { elapsedSeconds: elapsedRaw, value: null };
  return {
    elapsedSeconds: Math.min(elapsedRaw, segment),
    value: Math.min(elapsedRaw / segment, 0.99),
  };
}
