import assert from 'node:assert/strict';
import { applyTempoGrid } from '../src/rhythmGrid.js';

const tempo = {
  available: true,
  confidence: 0.9,
  pulseBpm: 150,
  phaseSeconds: 0.2,
  durationSeconds: 2,
};

const note = (midi, start, confidence = 0.7) => ({
  midi,
  start,
  end: start + 0.25,
  duration: 0.25,
  confidence,
  consensus: 2 / 3,
  amplitude: 0.7,
  detectionSources: ['strict', 'balanced'],
});

const clusters = [
  // Pulse 0 primary half-slot: two groups should merge into one stroke/chord.
  { anchor: 0.16, guitarEarSupport: 'presence', notes: [note(60, 0.16, 0.75)] },
  { anchor: 0.24, guitarEarSupport: 'presence', notes: [note(64, 0.24, 0.78)] },
  // Pulse 0 secondary half-slot: strong attack support, must survive.
  { anchor: 0.39, guitarEarSupport: 'attack', guitarEarAttackDistance: 0.01, notes: [note(67, 0.39, 0.70)] },

  // Pulse 1 primary half-slot: keep.
  { anchor: 0.59, guitarEarSupport: 'presence', notes: [note(69, 0.59, 0.76)] },
  // Pulse 1 secondary: weak/uncertain, must be merged away/rejected.
  { anchor: 0.80, guitarEarSupport: 'uncertain-presence', notes: [note(71, 0.80, 0.70)] },
];

const result = applyTempoGrid(clusters, tempo);
assert.equal(result.stats.enabled, true);
assert.equal(result.stats.mode, 'tempo-adaptive-stroke-v3');
assert.equal(result.stats.slotsPerPulse, 2);
assert.equal(result.stats.maxStrokesPerPulse, 2);
assert.equal(result.stats.adaptiveSecondaryStroke, true);
assert.equal(result.stats.secondaryCandidateCount, 2);
assert.equal(result.stats.secondaryStrokeCount, 1);
assert.equal(result.stats.secondaryRejectedCount, 1);
assert.equal(result.clusters.length, 3, 'two pulses should yield two primary strokes plus one strong secondary');

const first = result.clusters[0];
assert.ok(Math.abs(first.anchor - 0.2) < 1e-9, `expected first stroke at 0.2s, got ${first.anchor}`);
assert.deepEqual(first.notes.map(n => n.midi).sort((a, b) => a - b), [60, 64]);
assert.ok(first.notes.every(n => Math.abs(n.start - first.anchor) < 1e-9), 'merged notes must share quantized onset');

const second = result.clusters[1];
assert.ok(Math.abs(second.anchor - 0.4) < 1e-9, `expected strong secondary at 0.4s, got ${second.anchor}`);
assert.equal(second.guitarEarSupport, 'attack');

const third = result.clusters[2];
assert.ok(Math.abs(third.anchor - 0.6) < 1e-9, `expected next primary at 0.6s, got ${third.anchor}`);
assert.ok(!result.clusters.some(c => Math.abs(Number(c.anchor) - 0.8) < 1e-9), 'weak uncertain secondary must not survive');

console.log('RHYTHM_ADAPTIVE_STROKE_OK', result.stats);
