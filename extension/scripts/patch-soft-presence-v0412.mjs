import fs from 'node:fs';

const path = 'src/guitarEnginePhase2d.js';
let text = fs.readFileSync(path, 'utf8');

text = text.replace(
  "const GUITAR_EAR_ACTIVE_PAD_SECONDS = 0.08;",
  "const GUITAR_EAR_ACTIVE_PAD_SECONDS = 0.08;\nconst UNCERTAIN_FALLBACK_MIN_SPACING_SECONDS = 0.18;"
);

const start = text.indexOf('function applyGuitarEarGate(clusters, guitarEar) {');
const end = text.indexOf('\nfunction positionCandidates', start);
if (start < 0 || end < 0) throw new Error('Could not locate Guitar Ear gate');

const gate = `function representativeNote(notes) {
  return [...notes].sort((a, b) =>
    (Number(b.consensus || 0) - Number(a.consensus || 0)) ||
    (Number(b.confidence || 0) - Number(a.confidence || 0)) ||
    (Number(b.duration || 0) - Number(a.duration || 0))
  )[0] || null;
}

function bestUncertainFallbackNote(notes, previousMidi) {
  let best = null;
  let bestScore = -Infinity;
  for (const note of notes) {
    const confidence = Number(note.confidence || 0);
    const consensus = Number(note.consensus || 0);
    const duration = Math.min(0.5, Number(note.duration || 0));
    const distance = Number.isFinite(previousMidi) ? Math.min(12, Math.abs(Number(note.midi) - previousMidi)) : 0;
    const continuity = Number.isFinite(previousMidi) ? 1 - (distance / 12) : 0.5;
    const score = (consensus * 0.42) + (confidence * 0.42) + (continuity * 0.12) + (duration * 0.08);
    if (score > bestScore) { bestScore = score; best = note; }
  }
  return best;
}

function applyGuitarEarGate(clusters, guitarEar) {
  const preCount = clusters.length;
  if (!guitarEar?.available) return { clusters, stats: { enabled:false, mode:'disabled', preGateOnsetGroups:preCount, postGateOnsetGroups:preCount, gateRejectedGroups:0, rejectedOutsideActiveRegions:0, rejectedWithoutAttackSupport:0, attackMatchedGroups:0, presenceOnlyGroups:0, uncertainFallbackGroups:0, uncertainFallbackRateLimitedGroups:0 } };

  const intervals = guitarEar.activeIntervals || [];
  const attacks = (guitarEar.attackTimes || []).map(Number);
  const kept = [];
  let attackMatched = 0, presenceOnly = 0, outsideActive = 0, uncertainFallback = 0, uncertainRateLimited = 0;
  let lastFallbackAnchor = -Infinity;
  let previousMidi = null;

  for (const original of clusters) {
    const anchor = Number(original.anchor);
    if (inActiveInterval(anchor, intervals)) {
      const distance = nearestAttackDistance(anchor, attacks);
      if (distance !== null && distance <= GUITAR_EAR_ATTACK_MATCH_SECONDS) { kept.push({ ...original, guitarEarSupport:'attack', guitarEarAttackDistance:distance }); attackMatched += 1; }
      else { kept.push({ ...original, guitarEarSupport:'presence' }); presenceOnly += 1; }
      const rep = representativeNote(original.notes);
      if (rep) previousMidi = Number(rep.midi);
      continue;
    }

    outsideActive += 1;
    if (anchor - lastFallbackAnchor < UNCERTAIN_FALLBACK_MIN_SPACING_SECONDS) { uncertainRateLimited += 1; continue; }
    const fallback = bestUncertainFallbackNote(original.notes, previousMidi);
    if (!fallback) { uncertainRateLimited += 1; continue; }
    kept.push({ ...original, notes:[fallback], guitarEarSupport:'uncertain-presence' });
    previousMidi = Number(fallback.midi);
    lastFallbackAnchor = anchor;
    uncertainFallback += 1;
  }

  return { clusters:kept, stats:{ enabled:true, mode:'presence-soft-fallback-v1', preGateOnsetGroups:preCount, postGateOnsetGroups:kept.length, gateRejectedGroups:preCount-kept.length, outsideActiveGroups:outsideActive, rejectedOutsideActiveRegions:0, rejectedWithoutAttackSupport:0, attackMatchedGroups:attackMatched, presenceOnlyGroups:presenceOnly, uncertainFallbackGroups:uncertainFallback, uncertainFallbackRateLimitedGroups:uncertainRateLimited, uncertainFallbackMinSpacingSeconds:UNCERTAIN_FALLBACK_MIN_SPACING_SECONDS, attackMatchWindowSeconds:GUITAR_EAR_ATTACK_MATCH_SECONDS, activeRegionPaddingSeconds:GUITAR_EAR_ACTIVE_PAD_SECONDS } };
}
`;

text = text.slice(0, start) + gate + text.slice(end);
fs.writeFileSync(path, text);

for (const file of ['manifest.json','package.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = '0.4.12';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
