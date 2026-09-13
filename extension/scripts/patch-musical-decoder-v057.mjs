import fs from 'node:fs';

const path = 'src/guitarEnginePhase2d.js';
let text = fs.readFileSync(path, 'utf8');

function replace(from, to, label) {
  if (!text.includes(from)) throw new Error(`missing ${label}`);
  text = text.replace(from, to);
}

replace(
  "import { applyTempoGrid } from './rhythmGrid.js';",
  "import { applyTempoGrid } from './rhythmGrid.js';\nimport { decodeGuitarPerformance } from './guitarMusicalDecoder.js';",
  'rhythm grid import',
);

replace(
  '  const rhythmic = applyTempoGrid(gated.clusters, tempo);',
  '  const rhythmic = applyTempoGrid(gated.clusters, tempo);\n  const musical = decodeGuitarPerformance(rhythmic.clusters, tempo);',
  'tempo grid call',
);

replace(
  '  rhythmic.clusters.forEach((cluster, chordId) => {',
  '  musical.clusters.forEach((cluster, chordId) => {',
  'rhythmic cluster iteration',
);

replace(
  "        rhythmBeatIndex: cluster.rhythmBeatIndex ?? null, rhythmSubdivision: cluster.rhythmSubdivision ?? null,",
  "        rhythmBeatIndex: cluster.rhythmBeatIndex ?? null, rhythmSubdivision: cluster.rhythmSubdivision ?? null,\n        musicalRole: cluster.musicalRole || 'unknown',",
  'note musical role metadata',
);

replace(
  '      onsetGroups: rhythmic.clusters.length,',
  '      onsetGroups: musical.clusters.length,',
  'musical onset count',
);

replace(
  '      guitarEarGate: gated.stats,\n      tempo, rhythm: rhythmic.stats,',
  '      guitarEarGate: gated.stats,\n      tempo, rhythm: rhythmic.stats, musicalDecoder: musical.stats,',
  'musical summary stats',
);

fs.writeFileSync(path, text);

for (const file of ['manifest.json', 'package.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = '0.5.7';
  if (file === 'manifest.json') {
    data.description = 'Capture 90 seconds of YouTube audio, transcribe with stable Guitar Ear Phase-2d plus adaptive tempo, then decode candidates into musically plausible guitar chords and lead gestures before playback and TAB.';
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('MUSICAL_DECODER_V057_PATCH_OK guitar-performance-decoder-v1');
