import assert from 'node:assert/strict';
import {
  estimatePhase2eRhythmSamples,
  makePhase2eRhythmFeatures,
} from '../src/guitarEarRhythm.js';

const SAMPLE_RATE = 16000;
const SECONDS = 20;
const ROWS = [0, 1, 25, 50, 100, 300];

function clickTrack(bpm) {
  const audio = new Float32Array(Math.round(SECONDS * SAMPLE_RATE));
  const period = 60 / bpm;
  for (let time = 0.25; time < SECONDS; time += period) {
    const start = Math.round(time * SAMPLE_RATE);
    const length = Math.min(160, audio.length - start);
    for (let i = 0; i < length; i += 1) {
      const env = Math.exp(-i / 24);
      const carrier = i % 2 === 0 ? 1 : -1;
      audio[start + i] += 0.8 * env * carrier;
    }
  }
  return audio;
}

const fixtures = {
  120: {
    estimate: { rawBpm: 120, pulseBpm: 120, phaseSeconds: 0.18, slotSeconds: 0.25, confidence: 1, autocorrelation: 1 },
    rows: [
      [-0.7705133557,-0.6374238133, 0.9822872877,-0.1873811930,0.4400000572,0.5,1,1],
      [-0.8443278074,-0.5358269811, 0.9048269987,-0.4257793725,0.3600000143,0.5,1,1],
      [ 0.7705132365, 0.6374240518, 0.9822872877,-0.1873811930,0.4400000572,0.5,1,1],
      [-0.7705133557,-0.6374238133, 0.9822872877,-0.1873811930,0.4400000572,0.5,1,1],
      [-0.7705133557,-0.6374238133, 0.9822872877,-0.1873811930,0.4400000572,0.5,1,1],
      [-0.7705127597,-0.6374245882, 0.9822875857,-0.1873796731,0.4400005341,0.5,1,1],
    ],
  },
  72: {
    estimate: { rawBpm: 71.4286, pulseBpm: 71.4286, phaseSeconds: 0.12, slotSeconds: 0.42, confidence: 1, autocorrelation: 0.766631 },
    rows: [
      [-0.7818313241, 0.6234900355,-0.9749280214,-0.2225205451,0.4285714626,0.1257693768,1,1],
      [-0.7330515981, 0.6801730990,-0.9972037673,-0.0747302696,0.4761904478,0.1257693768,1,1],
      [ 0.8262388110, 0.5633199811, 0.9308736920,-0.3653411567,0.3809523582,0.1257693768,1,1],
      [ 0.2947551310,-0.9555728436,-0.5633199811, 0.8262388110,0.8095238209,0.1257693768,1,1],
      [ 0.2947555184, 0.9555727243, 0.5633206964, 0.8262383342,0.8095235825,0.1257693768,1,1],
      [ 0.4338821173,-0.9009696245,-0.7818292379, 0.6234925985,0.7142868042,0.1257693768,1,1],
    ],
  },
};

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

for (const [bpmText, fixture] of Object.entries(fixtures)) {
  const bpm = Number(bpmText);
  const estimate = estimatePhase2eRhythmSamples(clickTrack(bpm), SAMPLE_RATE);
  assert.equal(estimate.available, true, `tempo ${bpm} should be available`);
  close(estimate.rawBpm, fixture.estimate.rawBpm, 0.02, `${bpm} rawBpm`);
  close(estimate.pulseBpm, fixture.estimate.pulseBpm, 0.02, `${bpm} pulseBpm`);
  close(estimate.phaseSeconds, fixture.estimate.phaseSeconds, 0.021, `${bpm} phaseSeconds`);
  close(estimate.slotSeconds, fixture.estimate.slotSeconds, 0.002, `${bpm} slotSeconds`);
  close(estimate.confidence, fixture.estimate.confidence, 0.02, `${bpm} confidence`);
  close(estimate.autocorrelation, fixture.estimate.autocorrelation, 0.025, `${bpm} autocorrelation`);

  const features = makePhase2eRhythmFeatures({
    nFrames: 301,
    hopSeconds: 0.01,
    cropStartSeconds: 0,
    slotSeconds: estimate.slotSeconds,
    phaseSeconds: estimate.phaseSeconds,
    confidence: estimate.confidence,
    available: estimate.available,
  });
  assert.equal(features.length, 301 * 8);

  ROWS.forEach((row, rowIndex) => {
    const actual = Array.from(features.subarray(row * 8, row * 8 + 8));
    fixture.rows[rowIndex].forEach((expected, column) => {
      close(actual[column], expected, 0.006, `${bpm} feature row ${row} col ${column}`);
    });
  });
  console.log(`PHASE2E_RHYTHM_FIXTURE_OK bpm=${bpm} pulse=${estimate.pulseBpm} phase=${estimate.phaseSeconds} slot=${estimate.slotSeconds}`);
}

const zeros = makePhase2eRhythmFeatures({
  nFrames: 301,
  hopSeconds: 0.01,
  cropStartSeconds: 0,
  slotSeconds: null,
  phaseSeconds: null,
  confidence: 0,
  available: false,
});
assert.ok(Array.from(zeros).every(value => value === 0), 'unavailable rhythm must produce an all-zero tensor');

console.log('PHASE2E_JS_PYTHON_RHYTHM_PARITY_OK');
