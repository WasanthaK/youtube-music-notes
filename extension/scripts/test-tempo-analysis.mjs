import { analyzeTempoSamples } from '../src/tempoAnalysis.js';

function track(bpm, seconds = 24, sampleRate = 22050) {
  const x = new Float32Array(seconds * sampleRate);
  for (let t = 0.25; t < seconds; t += 60 / bpm) {
    const a = Math.round(t * sampleRate);
    for (let i = 0; i < 180 && a + i < x.length; i += 1) {
      x[a + i] += Math.exp(-i / 28) * (i % 2 ? 0.7 : -0.7);
    }
  }
  return [x, sampleRate];
}

for (const targetBpm of [120, 72]) {
  const [x, sampleRate] = track(targetBpm);
  const r = analyzeTempoSamples(x, sampleRate);
  const tempoMatches = Math.abs(r.bpm - targetBpm) <= 4 || Math.abs(r.pulseBpm - targetBpm) <= 4;
  const expectedSlotSeconds = 60 / (targetBpm * 2);
  const slotMatches = Math.abs(r.suggestedSlotSeconds - expectedSlotSeconds) <= 0.03;
  if (!r.available || !tempoMatches || !slotMatches || r.confidence < 0.25) {
    throw new Error(`tempo test failed target=${targetBpm} got=${JSON.stringify(r)}`);
  }
  console.log(`TEMPO_OK target=${targetBpm} bpm=${r.bpm} pulse=${r.pulseBpm} slot=${r.suggestedSlotSeconds} confidence=${r.confidence}`);
}
