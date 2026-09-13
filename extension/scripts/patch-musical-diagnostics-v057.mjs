import fs from 'node:fs';

const path = 'src/offscreen-phase2d.js';
let text = fs.readFileSync(path, 'utf8');

function replace(from, to, label) {
  if (!text.includes(from)) throw new Error(`missing ${label}`);
  text = text.replace(from, to);
}

replace(
  '      rhythm: s.rhythm || null,',
  '      rhythm: s.rhythm || null,\n      musical_decoder: s.musicalDecoder || null,',
  'musical decoder diagnostics',
);

replace(
  '        support: note.guitarEarSupport || null,\n        rhythm_slot:',
  "        support: note.guitarEarSupport || null,\n        musical_role: note.musicalRole || null,\n        rhythm_slot:",
  'musical role note trace',
);

fs.writeFileSync(path, text);
console.log('MUSICAL_DIAGNOSTICS_V057_PATCH_OK');
