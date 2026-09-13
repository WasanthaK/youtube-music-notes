import fs from 'node:fs';
const p='src/guitarEnginePhase2d.js';let t=fs.readFileSync(p,'utf8');
const r=(a,b,l)=>{if(!t.includes(a))throw new Error(`missing ${l}`);t=t.replace(a,b);};
r("import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';","import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';\nimport { applyTempoGrid } from './rhythmGrid.js';",'import');
r('export function buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar) {','export function buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar, tempo = null) {','signature');
r('  const gated = applyGuitarEarGate(preGateClusters, guitarEar);','  const gated = applyGuitarEarGate(preGateClusters, guitarEar);\n  const rhythmic = applyTempoGrid(gated.clusters, tempo);','gate');
r('  gated.clusters.forEach((cluster, chordId) => {','  rhythmic.clusters.forEach((cluster, chordId) => {','iteration');
r("        guitarEarSupport: cluster.guitarEarSupport || 'not-enabled',","        guitarEarSupport: cluster.guitarEarSupport || 'not-enabled',\n        rhythmSlot: cluster.rhythmSlot ?? null, rhythmSlotTime: cluster.rhythmSlotTime ?? null,\n        rhythmBeatIndex: cluster.rhythmBeatIndex ?? null, rhythmSubdivision: cluster.rhythmSubdivision ?? null,",'note rhythm');
r('      onsetGroups: gated.clusters.length,','      onsetGroups: rhythmic.clusters.length,','onset count');
r('      guitarEarGate: gated.stats,','      guitarEarGate: gated.stats,\n      tempo, rhythm: rhythmic.stats,','summary');
r("? 'guitar-ear-v0.2d+basic-pitch-ensemble-v2-browser'", "? (rhythmic.stats.enabled ? 'guitar-ear-v0.2d+basic-pitch-ensemble-v2-browser-tempo-v1' : 'guitar-ear-v0.2d+basic-pitch-ensemble-v2-browser')",'engine');
fs.writeFileSync(p,t);
for(const f of ['manifest.json','package.json']){const d=JSON.parse(fs.readFileSync(f,'utf8'));d.version='0.5.0';fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n');}
