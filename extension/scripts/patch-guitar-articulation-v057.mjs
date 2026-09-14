import fs from 'node:fs';

function replaceIn(path, replacements) {
  let text = fs.readFileSync(path, 'utf8');
  for (const [from, to, label] of replacements) {
    if (!text.includes(from)) throw new Error(`${path}: missing ${label}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

replaceIn('result.js', [
  [
    "  const sourceRemaining = Math.max(0.04, sourceWindowEndSeconds - note.start);\n  const sourceDuration = Math.max(0.05, Math.min(note.end - note.start, sourceRemaining, 2.6));\n  const wallDuration = sourceDuration / playbackRate;\n  const releaseTail = Math.min(0.24 / playbackRate, 0.34);\n  const audibleDuration = Math.max(0.16, Math.min(wallDuration + releaseTail, 2.9));",
    "  const sourceRemaining = Math.max(0.04, sourceWindowEndSeconds - note.start);\n  const musicalRole = note.musicalRole || 'unknown';\n  const maxSourceDuration = musicalRole === 'lead' ? 1.10 : musicalRole === 'double-stop' ? 0.52 : 0.38;\n  const sourceDuration = Math.max(0.05, Math.min(note.end - note.start, sourceRemaining, maxSourceDuration));\n  const wallDuration = sourceDuration / playbackRate;\n  const releaseTail = musicalRole === 'lead'\n    ? Math.min(0.12 / playbackRate, 0.18)\n    : Math.min(0.045 / playbackRate, 0.07);\n  const maxAudibleDuration = musicalRole === 'lead' ? 1.20 : musicalRole === 'double-stop' ? 0.58 : 0.44;\n  const audibleDuration = Math.max(0.12, Math.min(wallDuration + releaseTail, maxAudibleDuration));",
    'role-aware detected guitar duration',
  ],
]);

replaceIn('clean-playback.js', [
  [
    "    } else {\n      legatoDuration = Math.max(0.18, Math.min(1.1, detectedDuration));\n    }",
    "    } else {\n      const musicalRole = note.musicalRole || 'unknown';\n      const maxDryDuration = musicalRole === 'lead' ? 0.72 : musicalRole === 'double-stop' ? 0.46 : 0.34;\n      legatoDuration = Math.max(0.12, Math.min(maxDryDuration, detectedDuration));\n    }",
    'clean role-aware duration',
  ],
  [
    "      const duration = Math.max(0.20, Math.min(0.68, strokeWindow * 0.92));",
    "      const musicalRole = note.musicalRole || 'unknown';\n      const roleMax = musicalRole === 'lead' ? 0.58 : musicalRole === 'double-stop' ? 0.44 : 0.34;\n      const duration = Math.max(0.12, Math.min(roleMax, strokeWindow * 0.72));",
    'rhythm guitar dry decay',
  ],
  [
    "      gain.gain.exponentialRampToValueAtTime(Math.max(0.018, peak * 0.38), when + Math.min(0.12, duration * 0.40));",
    "      gain.gain.exponentialRampToValueAtTime(Math.max(0.012, peak * 0.24), when + Math.min(0.085, duration * 0.34));",
    'rhythm guitar faster decay',
  ],
  [
    "  const lead = extractLeadLine(result.notes)\n    .filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds);",
    "  const roleLeadNotes = result.notes.filter(note => note.musicalRole === 'lead' || note.musicalRole === 'double-stop');\n  const lead = extractLeadLine(roleLeadNotes.length ? roleLeadNotes : result.notes)\n    .filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds);",
    'violin lead roles',
  ],
]);

for (const file of ['manifest.json', 'package.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = '0.5.7';
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('GUITAR_ARTICULATION_V057_PATCH_OK rhythm=dry lead=sustained');
