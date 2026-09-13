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
  { anchor: 0.16, guitarEarSupport: 'presence', notes: [note(60, 0.16, 0.72)] },
  { anchor: 0.24, guitarEarSupport: 'attack', guitarEarAttackDistance: 0.02, notes: [note(64, 0.24, 0.82)] },
  { anchor: 0.29, guitarEarSupport: 'presence', notes: [note(60, 0.29, 0.80)] },
  { anchor: 0.57, guitarEarSupport: 'presence', notes: [note(67, 0.57, 0.76)] },
  { anchor: 0.63, guitarEarSupport: 'attack', guitarEarAttackDistance: 0.01, notes: [note(71, 0.63, 0.79)] },
];

const result = applyTempoGrid(clusters, tempo);
assert.equal(result.stats.enabled, true);
assert.equal(result.stats.mode, 'tempo-stroke-merge-v2');
assert.equal(result.stats.slotsPerPulse, 1);
assert.equal(result.stats.maxOneStrokePerPulse, true);
assert.equal(result.clusters.length, 2, 'five onset candidates across two pulses must become two strokes');
assert.equal(result.stats.preRhythmOnsetGroups, 5);
assert.equal(result.stats.postRhythmOnsetGroups, 2);
assert.equal(result.stats.mergedByRhythm, 3);

const first = result.clusters[0];
assert.ok(Math.abs(first.anchor - 0.2) < 1e-9, `expected first stroke at 0.2s, got ${first.anchor}`);
assert.deepEqual(first.notes.map(n => n.midi).sort((a, b) => a - b), [60, 64]);
assert.equal(first.notes.filter(n => n.midi === 60).length, 1, 'duplicate MIDI must merge inside a stroke');
assert.ok(first.notes.every(n => Math.abs(n.start - first.anchor) < 1e-9), 'merged notes must share the quantized stroke onset');
assert.equal(first.guitarEarSupport, 'attack', 'strongest Guitar Ear support must survive the merge');

const second = result.clusters[1];
assert.ok(Math.abs(second.anchor - 0.6) < 1e-9, `expected second stroke at 0.6s, got ${second.anchor}`);
assert.deepEqual(second.notes.map(n => n.midi).sort((a, b) => a - b), [67, 71]);

console.log('RHYTHM_STROKE_MERGE_OK', {
  pre: result.stats.preRhythmOnsetGroups,
  post: result.stats.postRhythmOnsetGroups,
  pulseSeconds: result.stats.slotSeconds,
});
