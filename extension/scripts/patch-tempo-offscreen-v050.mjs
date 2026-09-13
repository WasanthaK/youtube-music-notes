import fs from 'node:fs';

const path = 'src/offscreen-phase2d.js';
let text = fs.readFileSync(path, 'utf8');
const rep = (from, to, label) => {
  if (!text.includes(from)) throw new Error(`missing ${label}`);
  text = text.replace(from, to);
};

rep(
  "import { analyzeGuitarEar } from './guitarEarBrowser.js';",
  "import { analyzeGuitarEar } from './guitarEarBrowser.js';\nimport { analyzeTempo } from './tempoAnalysis.js';",
  'Guitar Ear import'
);
rep(
  '  const basicPitchAudio = await resampleMono(decoded, 22050);',
  "  const basicPitchAudio = await resampleMono(decoded, 22050);\n  await reportProgress('Learning tempo and beat grid in Chrome…');\n  const tempo = analyzeTempo(basicPitchAudio);",
  'Basic Pitch audio'
);
rep(
  'buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar)',
  'buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar, tempo)',
  'Phase-2d call'
);
rep(
  '      guitar_ear: compactGuitarEar(s),',
  '      guitar_ear: compactGuitarEar(s),\n      tempo: s.tempo || null,\n      rhythm: s.rhythm || null,',
  'diagnostic summary'
);
rep(
  "        support: note.guitarEarSupport || null,\n        string: note.guitar?.string ?? null,",
  "        support: note.guitarEarSupport || null,\n        rhythm_slot: Number.isFinite(Number(note.rhythmSlot)) ? Number(note.rhythmSlot) : null,\n        rhythm_beat: Number.isFinite(Number(note.rhythmBeatIndex)) ? Number(note.rhythmBeatIndex) : null,\n        rhythm_subdivision: Number.isFinite(Number(note.rhythmSubdivision)) ? Number(note.rhythmSubdivision) : null,\n        rhythm_slot_time: Number.isFinite(Number(note.rhythmSlotTime)) ? Number(note.rhythmSlotTime) : null,\n        string: note.guitar?.string ?? null,",
  'note trace'
);

fs.writeFileSync(path, text);
