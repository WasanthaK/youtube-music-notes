// Tests the pure popup helpers (docs/UX_SPEC.md §5.2 progress table, §5.3 capture from current position).
// Run from extension/: node scripts/test-popup-progress.mjs
import assert from 'node:assert/strict';
import {
  analysisProgress,
  planCurrentCapture,
  roundDownToTenth,
  formatClock,
  recordingProgress,
  settleCurrentCapture,
  canResetState,
  doneStatusText,
  TOO_LITTLE_LEFT_MESSAGE,
} from '../popup-progress.js';

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`);

// §5.2 table, with the exact strings sent today (service_worker.js, src/offscreen-phase2d.js, src/pipeline.js)
// and wording without "in Chrome".
const rows = [
  ['Analysing exact YouTube segment…', 0.01, 'starting'],
  ['Decoding captured audio locally…', 0.03, 'decoding audio'],
  ['Learning tempo and beat grid in Chrome…', 0.08, 'finding the beat'],
  ['Learning tempo and beat grid…', 0.08, 'finding the beat'],
  ['Guitar Ear Phase-2e is listening with rhythm conditioning in Chrome…', 0.15, 'listening for guitar'],
  ['Guitar Ear Phase-2e is listening with rhythm conditioning…', 0.15, 'listening for guitar'],
  ['Guitar Ear unavailable; continuing with browser Basic Pitch fallback…', 0.15, 'listening for guitar'],
  ['Transcribing locally with Basic Pitch…', 0.30, 'detecting notes'],
  ['Basic Pitch in Chrome… 0%', 0.30, 'detecting notes 0 %'],
  ['Basic Pitch in Chrome… 55%', 0.30 + 0.65 * 0.55, 'detecting notes 55 %'],
  ['Basic Pitch in Chrome… 100%', 0.95, 'detecting notes 100 %'],
  ['Basic Pitch… 40%', 0.30 + 0.65 * 0.40, 'detecting notes 40 %'],
  ['Basic Pitch 7%', 0.30 + 0.65 * 0.07, 'detecting notes 7 %'],
];
for (const [message, progress, stage] of rows) {
  const got = analysisProgress(message, { progress: 0.5, stage: 'previous' });
  close(got.progress, progress, message);
  assert.equal(got.stage, stage, message);
}

// Anything else keeps the last value and text.
const previous = { progress: 0.4275, stage: 'detecting notes 19 %' };
for (const message of ['Analysing locally…', 'Saving result…', '', null, undefined, 'Something about Basic Pitch without a number']) {
  assert.deepEqual(analysisProgress(message, previous), previous, String(message));
}
assert.deepEqual(analysisProgress('Unknown', null), { progress: null, stage: null });
// Percent beyond 100 is clamped.
close(analysisProgress('Basic Pitch in Chrome… 250%').progress, 0.95, 'clamp');

// Rounding down to 0.1 s.
assert.equal(roundDownToTenth(83.79), 83.7);
assert.equal(roundDownToTenth(2.3), 2.3); // 2.3 * 10 = 22.999… in floating point
assert.equal(roundDownToTenth(0.7), 0.7);
assert.equal(roundDownToTenth(0.05), 0);
assert.equal(roundDownToTenth(12), 12);

// Range from the current position.
assert.deepEqual(planCurrentCapture(83.79, 300, 90), { ok: true, startSeconds: 83.7, endSeconds: 173.7, segmentSeconds: 90 });
let plan = planCurrentCapture(200.04, 230, 90); // end clamped to the duration
assert.equal(plan.ok, true);
assert.equal(plan.startSeconds, 200);
assert.equal(plan.endSeconds, 230);
assert.equal(plan.segmentSeconds, 30);
plan = planCurrentCapture(225, 230, 30); // exactly 5 s left is allowed
assert.equal(plan.ok, true);
assert.equal(plan.endSeconds, 230);
assert.deepEqual(planCurrentCapture(225.2, 230, 30), { ok: false, error: TOO_LITTLE_LEFT_MESSAGE });
assert.deepEqual(planCurrentCapture(229.99, 230, 60), { ok: false, error: TOO_LITTLE_LEFT_MESSAGE });
assert.deepEqual(planCurrentCapture(240, 230, 30), { ok: false, error: TOO_LITTLE_LEFT_MESSAGE });
// The 5 s test uses the rounded start: 224.96 → 224.9, 5.1 s left.
assert.equal(planCurrentCapture(224.96, 230, 30).ok, true);
assert.equal(TOO_LITTLE_LEFT_MESSAGE, 'Less than 5 seconds left in this video.');
// Unknown / live duration: no clamp.
assert.deepEqual(planCurrentCapture(10, null, 30), { ok: true, startSeconds: 10, endSeconds: 40, segmentSeconds: 30 });
assert.deepEqual(planCurrentCapture(10, Infinity, 60), { ok: true, startSeconds: 10, endSeconds: 70, segmentSeconds: 60 });
assert.deepEqual(planCurrentCapture(10, NaN, 60), { ok: true, startSeconds: 10, endSeconds: 70, segmentSeconds: 60 });
assert.equal(planCurrentCapture(0, 600, 90).startSeconds, 0);
assert.equal(planCurrentCapture(NaN, 600, 90).ok, false);
assert.equal(planCurrentCapture(-1, 600, 90).ok, false);
assert.equal(planCurrentCapture(5, 600, 0).ok, false);

// Settling on the paused position: never a seek within 0.1 s; the real start is recorded.
assert.deepEqual(settleCurrentCapture(83.7834, 300, 90), { ok: true, startSeconds: 83.783, endSeconds: 173.783, segmentSeconds: 90, seek: false });
assert.deepEqual(settleCurrentCapture(83.7, 300, 90), { ok: true, startSeconds: 83.7, endSeconds: 173.7, segmentSeconds: 90, seek: false });
assert.deepEqual(settleCurrentCapture(83.79999, 300, 30), { ok: true, startSeconds: 83.8, endSeconds: 113.8, segmentSeconds: 30, seek: false });
let settled = settleCurrentCapture(210.06, 230, 30); // end clamped from the real start
assert.equal(settled.ok, true);
assert.equal(settled.seek, false);
assert.equal(settled.startSeconds, 210.06);
assert.equal(settled.endSeconds, 230);
assert.equal(settled.segmentSeconds, 19.94);
// Rounded start leaves exactly 5 s but the real start leaves less: error (caller resumes the video).
assert.deepEqual(settleCurrentCapture(225.05, 230, 30), { ok: false, error: TOO_LITTLE_LEFT_MESSAGE });
assert.deepEqual(settleCurrentCapture(228, 230, 30), { ok: false, error: TOO_LITTLE_LEFT_MESSAGE });
// A larger gap than the tolerance asks for a seek to the rounded start.
assert.deepEqual(settleCurrentCapture(83.79, 300, 90, 0.05), { ok: true, startSeconds: 83.7, endSeconds: 173.7, segmentSeconds: 90, seek: true });
// Unknown duration: no clamp.
assert.deepEqual(settleCurrentCapture(10.04, null, 60), { ok: true, startSeconds: 10.04, endSeconds: 70.04, segmentSeconds: 60, seek: false });

// RESET_STATE guard.
assert.equal(canResetState('done'), true);
assert.equal(canResetState('error'), true);
for (const state of ['idle', 'recording', 'analysing', undefined]) assert.equal(canResetState(state), false, String(state));

// Done text: never claims a new tab; keeps the retry sentence.
assert.equal(doneStatusText(212, 'Done: 212 notes detected.'), 'Done: 212 notes. The result is open in its own tab.');
assert.equal(doneStatusText(0, 'Done: 0 notes detected.'), 'Done: 0 notes. The result is open in its own tab.');
assert.equal(doneStatusText(null, 'Done: 37 notes detected. Diagnostic upload will retry from the result page.'),
  'Done: 37 notes. The result is open in its own tab. Diagnostic upload will retry from the result page.');
assert.equal(doneStatusText(undefined, ''), 'Done: 0 notes. The result is open in its own tab.');

// Clock text.
assert.equal(formatClock(0), '0:00');
assert.equal(formatClock(83.7), '1:23');
assert.equal(formatClock(173.7), '2:53');
assert.equal(formatClock(90), '1:30');
assert.equal(formatClock(3725), '1:02:05');
assert.equal(formatClock(-3), '0:00');

// Recording progress (computed in the popup from captureStartedAt + segmentSeconds).
let rec = recordingProgress(1_000_000, 90, 1_000_000 + 42_000);
assert.equal(rec.elapsedSeconds, 42);
close(rec.value, 42 / 90, 'recording 42 s');
rec = recordingProgress(1_000_000, 90, 1_000_000 + 120_000);
assert.equal(rec.elapsedSeconds, 90);
assert.equal(rec.value, 0.99);
rec = recordingProgress(null, 90, 5_000);
assert.equal(rec.elapsedSeconds, 0);
assert.equal(rec.value, 0);
rec = recordingProgress(1_000, null, 11_000);
assert.equal(rec.value, null);

console.log('POPUP_PROGRESS_TEST_OK');
