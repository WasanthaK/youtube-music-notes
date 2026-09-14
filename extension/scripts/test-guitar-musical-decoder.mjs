import assert from 'node:assert/strict';
import { decodeGuitarPerformance } from '../src/guitarMusicalDecoder.js';

const note = (midi, confidence, extras = {}) => ({
  midi,
  start: extras.start ?? 0,
  end: extras.end ?? 0.45,
  duration: (extras.end ?? 0.45) - (extras.start ?? 0),
  confidence,
  consensus: extras.consensus ?? 0.67,
  amplitude: extras.amplitude ?? confidence,
  detectionSources: ['strict', 'balanced'],
  guitarEarSupport: extras.support ?? 'presence',
});

const tempo = { pulseBpm: 150 };

// A single played note often produces octave/fifth partial candidates. This
// should become one lead voice rather than a three-note organ-like stack.
{
  const input = [{
    anchor: 0.20,
    guitarEarSupport: 'presence',
    notes: [
      note(52, 0.86),
      note(64, 0.67),
      note(71, 0.60),
    ],
  }];
  const result = decodeGuitarPerformance(input, tempo);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].musicalRole, 'lead');
  assert.equal(result.clusters[0].notes.length, 1);
  assert.equal(result.clusters[0].notes[0].midi, 52);
}

// A chord candidate should preserve harmony but suppress excessive repeated
// pitch classes/octave partials.
{
  const input = [{
    anchor: 0.40,
    guitarEarSupport: 'attack',
    notes: [
      note(48, 0.78, { support: 'attack' }), // C3 bass
      note(60, 0.73, { support: 'attack' }), // C4 duplicate root
      note(64, 0.83, { support: 'attack' }), // E4
      note(67, 0.81, { support: 'attack' }), // G4
      note(72, 0.69, { support: 'attack' }), // C5 duplicate root
    ],
  }];
  const result = decodeGuitarPerformance(input, tempo);
  assert.equal(result.clusters[0].musicalRole, 'chord');
  assert.ok(result.clusters[0].notes.length <= 4, 'decoded voicing should not preserve every octave partial');
  assert.ok(result.clusters[0].notes.some(n => n.midi === 48), 'bass note should anchor the chord');
  assert.ok(result.stats.duplicatePitchClassRemoved >= 1);
}

// Repeated same note without a new guitar attack is sustain, not another pluck.
{
  const input = [
    { anchor: 0.20, guitarEarSupport: 'presence', notes: [note(64, 0.80, { start: 0.20, end: 0.45 })] },
    { anchor: 0.34, guitarEarSupport: 'presence', notes: [note(64, 0.76, { start: 0.34, end: 0.62 })] },
  ];
  const result = decodeGuitarPerformance(input, tempo);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.stats.sameNoteRetriggersMerged, 1);
}

// A genuine new Guitar Ear attack is allowed to re-articulate the same pitch.
{
  const input = [
    { anchor: 0.20, guitarEarSupport: 'presence', notes: [note(64, 0.80, { start: 0.20, end: 0.45 })] },
    { anchor: 0.34, guitarEarSupport: 'attack', notes: [note(64, 0.78, { start: 0.34, end: 0.56, support: 'attack' })] },
  ];
  const result = decodeGuitarPerformance(input, tempo);
  assert.equal(result.clusters.length, 2);
}

// Rapid octave switching of the same pitch class without an attack should be
// suppressed rather than sounding like alternate-string partial tracking.
{
  const input = [
    { anchor: 0.20, guitarEarSupport: 'presence', notes: [note(52, 0.82, { start: 0.20 })] },
    { anchor: 0.35, guitarEarSupport: 'presence', notes: [note(64, 0.85, { start: 0.35 })] },
  ];
  const result = decodeGuitarPerformance(input, tempo);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.stats.octaveSwitchesSuppressed, 1);
}

console.log('GUITAR_MUSICAL_DECODER_OK');
