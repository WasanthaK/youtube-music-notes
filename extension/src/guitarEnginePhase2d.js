import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

const STRINGS = [
  { string: 1, stringName: 'e', openMidi: 64 },
  { string: 2, stringName: 'B', openMidi: 59 },
  { string: 3, stringName: 'G', openMidi: 55 },
  { string: 4, stringName: 'D', openMidi: 50 },
  { string: 5, stringName: 'A', openMidi: 45 },
  { string: 6, stringName: 'E', openMidi: 40 },
];

const GUITAR_MIN_HZ = 80;
const GUITAR_MAX_HZ = 1320;
const MAX_FRET = 24;
const ONSET_CLUSTER_SECONDS = 0.065;
const SAME_NOTE_MERGE_SECONDS = 0.055;
const GUITAR_EAR_ATTACK_MATCH_SECONDS = 0.18;
const GUITAR_EAR_ACTIVE_PAD_SECONDS = 0.08;
const GUITAR_EAR_STRONG_FALLBACK_CONFIDENCE = 0.88;

const PASSES = [
  { id: 'strict', onset: 0.40, frame: 0.28, minFrames: 5, energyTolerance: 10 },
  { id: 'balanced', onset: 0.30, frame: 0.22, minFrames: 4, energyTolerance: 11 },
  { id: 'sensitive', onset: 0.22, frame: 0.17, minFrames: 3, energyTolerance: 12 },
];

const clone2d = matrix => matrix.map(row => row.slice());
const clamp01 = value => Math.max(0, Math.min(1, Number(value)));
const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function decodePass(frames, onsets, contours, pass) {
  const noteFrames = outputToNotesPoly(
    clone2d(frames),
    clone2d(onsets),
    pass.onset,
    pass.frame,
    pass.minFrames,
    true,
    GUITAR_MAX_HZ,
    GUITAR_MIN_HZ,
    true,
    pass.energyTolerance,
  );

  return noteFramesToTime(addPitchBendsToNoteEvents(contours, noteFrames)).map(note => ({
    pass: pass.id,
    start: note.startTimeSeconds,
    end: Math.max(note.startTimeSeconds + 0.04, note.startTimeSeconds + note.durationSeconds),
    duration: Math.max(0.04, note.durationSeconds),
    midi: note.pitchMidi,
    amplitude: note.amplitude,
    pitchBends: note.pitchBends || [],
  }));
}

function mergePassDetections(passResults) {
  const buckets = [];
  for (const note of passResults.flat()) {
    let bucket = buckets.find(candidate =>
      candidate.midi === note.midi &&
      Math.abs(candidate.anchorStart - note.start) <= SAME_NOTE_MERGE_SECONDS
    );
    if (!bucket) {
      bucket = { midi: note.midi, anchorStart: note.start, detections: [] };
      buckets.push(bucket);
    }
    bucket.detections.push(note);
    bucket.anchorStart = bucket.detections.reduce((sum, item) => sum + item.start, 0) / bucket.detections.length;
  }

  return buckets.map(bucket => {
    const detections = bucket.detections;
    const best = detections.reduce((a, b) => b.amplitude > a.amplitude ? b : a);
    const sources = [...new Set(detections.map(item => item.pass))];
    const support = sources.length;
    const weightTotal = detections.reduce((sum, item) => sum + Math.max(0.05, item.amplitude), 0);
    const weightedStart = detections.reduce((sum, item) => sum + item.start * Math.max(0.05, item.amplitude), 0) / weightTotal;
    const weightedEnd = detections.reduce((sum, item) => sum + item.end * Math.max(0.05, item.amplitude), 0) / weightTotal;
    const consensus = support / PASSES.length;
    const confidence = clamp01((best.amplitude * 0.62) + (consensus * 0.38));
    return {
      start: weightedStart,
      end: Math.max(weightedStart + 0.04, weightedEnd),
      duration: Math.max(0.04, weightedEnd - weightedStart),
      midi: bucket.midi,
      amplitude: best.amplitude,
      confidence,
      consensus,
      detectionSources: sources,
      pitchBends: best.pitchBends || [],
    };
  }).filter(note => note.duration >= 0.04)
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
}

function isTeachingCandidate(note) {
  const sources = new Set(note.detectionSources);
  if (sources.size >= 2) return note.confidence >= 0.38 && note.duration >= 0.05;
  if (sources.has('strict')) return note.amplitude >= 0.38 && note.duration >= 0.06;
  if (sources.has('balanced')) return note.amplitude >= 0.46 && note.duration >= 0.08;
  if (sources.has('sensitive')) return note.amplitude >= 0.66 && note.duration >= 0.14;
  return false;
}

function groupIntoOnsets(notes) {
  const clusters = [];
  for (const note of notes) {
    const last = clusters[clusters.length - 1];
    if (!last || note.start - last.anchor > ONSET_CLUSTER_SECONDS) {
      clusters.push({ anchor: note.start, notes: [note] });
    } else {
      last.notes.push(note);
      last.anchor = last.notes.reduce((sum, item) => sum + item.start, 0) / last.notes.length;
    }
  }
  return clusters;
}

function inActiveInterval(anchor, intervals) {
  return intervals.some(interval =>
    Number(interval.start || 0) - GUITAR_EAR_ACTIVE_PAD_SECONDS <= anchor &&
    anchor <= Number(interval.end || 0) + GUITAR_EAR_ACTIVE_PAD_SECONDS
  );
}

function nearestAttackDistance(anchor, attacks) {
  if (!attacks.length) return null;
  let nearest = Infinity;
  for (const value of attacks) nearest = Math.min(nearest, Math.abs(anchor - Number(value)));
  return Number.isFinite(nearest) ? nearest : null;
}

function strongClusterFallback(cluster) {
  return cluster.notes.some(note =>
    Number(note.confidence || 0) >= GUITAR_EAR_STRONG_FALLBACK_CONFIDENCE &&
    Number(note.consensus || 0) >= 0.999
  );
}

function applyGuitarEarGate(clusters, guitarEar) {
  const preCount = clusters.length;
  if (!guitarEar?.available) {
    return {
      clusters,
      stats: {
        enabled: false,
        preGateOnsetGroups: preCount,
        postGateOnsetGroups: preCount,
        gateRejectedGroups: 0,
        rejectedOutsideActiveRegions: 0,
        rejectedWithoutAttackSupport: 0,
        attackMatchedGroups: 0,
        strongFallbackGroups: 0,
      },
    };
  }

  const intervals = guitarEar.activeIntervals || [];
  const attacks = (guitarEar.attackTimes || []).map(Number);
  const kept = [];
  let attackMatched = 0;
  let fallback = 0;
  let rejectedInactive = 0;
  let rejectedNoAttack = 0;

  for (const original of clusters) {
    const anchor = Number(original.anchor);
    if (!inActiveInterval(anchor, intervals)) {
      rejectedInactive += 1;
      continue;
    }

    const distance = nearestAttackDistance(anchor, attacks);
    if (distance !== null && distance <= GUITAR_EAR_ATTACK_MATCH_SECONDS) {
      kept.push({ ...original, guitarEarSupport: 'attack', guitarEarAttackDistance: distance });
      attackMatched += 1;
      continue;
    }

    if (strongClusterFallback(original)) {
      kept.push({ ...original, guitarEarSupport: 'strong-basic-pitch-fallback' });
      fallback += 1;
      continue;
    }

    rejectedNoAttack += 1;
  }

  return {
    clusters: kept,
    stats: {
      enabled: true,
      preGateOnsetGroups: preCount,
      postGateOnsetGroups: kept.length,
      gateRejectedGroups: preCount - kept.length,
      rejectedOutsideActiveRegions: rejectedInactive,
      rejectedWithoutAttackSupport: rejectedNoAttack,
      attackMatchedGroups: attackMatched,
      strongFallbackGroups: fallback,
      attackMatchWindowSeconds: GUITAR_EAR_ATTACK_MATCH_SECONDS,
      activeRegionPaddingSeconds: GUITAR_EAR_ACTIVE_PAD_SECONDS,
    },
  };
}

function positionCandidates(midi) {
  return STRINGS.map(string => ({
    string: string.string,
    stringName: string.stringName,
    fret: midi - string.openMidi,
  })).filter(position => position.fret >= 0 && position.fret <= MAX_FRET);
}

function assignmentCost(assignment, previousHandPosition) {
  const fretted = assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const minFret = fretted.length ? Math.min(...fretted) : 0;
  const hand = fretted.length ? median(fretted) : previousHandPosition;
  const spread = fretted.length > 1 ? maxFret - minFret : 0;

  let cost = 0;
  for (const item of assignment) {
    const fret = item.position.fret;
    const openBonus = fret === 0 ? -0.35 : 0;
    const highFretPenalty = fret > 12 ? (fret - 12) * 0.08 : 0;
    cost += fret * 0.04 + openBonus + highFretPenalty;
  }
  cost += spread * 0.55;
  cost += Math.abs(hand - previousHandPosition) * 0.22;
  return cost;
}

function solveAssignment(notes, previousHandPosition) {
  const candidateLists = notes.map(note => ({ note, positions: positionCandidates(note.midi) }));
  if (candidateLists.some(item => !item.positions.length)) return null;

  let best = null;
  function visit(index, usedStrings, assignment) {
    if (index === candidateLists.length) {
      const cost = assignmentCost(assignment, previousHandPosition);
      if (!best || cost < best.cost) best = { cost, assignment: assignment.map(item => ({ ...item })) };
      return;
    }
    const item = candidateLists[index];
    for (const position of item.positions) {
      if (usedStrings.has(position.string)) continue;
      usedStrings.add(position.string);
      assignment.push({ note: item.note, position });
      visit(index + 1, usedStrings, assignment);
      assignment.pop();
      usedStrings.delete(position.string);
    }
  }

  visit(0, new Set(), []);
  return best;
}

function assignClusterToGuitar(cluster, previousHandPosition) {
  let working = [...cluster].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  let solution = solveAssignment(working, previousHandPosition);
  while (!solution && working.length > 1) {
    working = working.slice(0, -1);
    solution = solveAssignment(working, previousHandPosition);
  }
  if (!solution) return { notes: [], handPosition: previousHandPosition };

  const frets = solution.assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const handPosition = frets.length ? median(frets) : previousHandPosition;
  return {
    handPosition,
    notes: solution.assignment.map(item => ({ ...item.note, guitar: item.position })),
  };
}

function bendSemitones(pitchBends) {
  if (!pitchBends?.length) return 0;
  const absolutePeak = pitchBends.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  return Math.round((absolutePeak / 3) * 10) / 10;
}

function compactGuitarEar(guitarEar) {
  if (!guitarEar) return { available: false };
  return {
    available: Boolean(guitarEar.available),
    device: guitarEar.device,
    model: guitarEar.model,
    presenceFrameThreshold: guitarEar.presenceFrameThreshold,
    presenceSegmentThreshold: guitarEar.presenceSegmentThreshold,
    attackThreshold: guitarEar.attackThreshold,
    meanPresence: guitarEar.meanPresence,
    activeFraction: guitarEar.activeFraction,
    attackCount: guitarEar.attackCount || 0,
    activeIntervals: guitarEar.activeIntervals || [],
    error: guitarEar.error || null,
  };
}

export function buildGuitarTranscriptionPhase2d(frames, onsets, contours, guitarEar) {
  const passResults = PASSES.map(pass => decodePass(frames, onsets, contours, pass));
  const merged = mergePassDetections(passResults);
  const teachingCandidates = merged.filter(isTeachingCandidate);
  const preGateClusters = groupIntoOnsets(teachingCandidates);
  const gated = applyGuitarEarGate(preGateClusters, guitarEar);

  const playable = [];
  let previousHandPosition = 3;
  gated.clusters.forEach((cluster, chordId) => {
    const assigned = assignClusterToGuitar(cluster.notes, previousHandPosition);
    previousHandPosition = assigned.handPosition;
    for (const note of assigned.notes) {
      playable.push({
        ...note,
        chordId,
        bendSemitones: bendSemitones(note.pitchBends),
        guitarEarSupport: cluster.guitarEarSupport || 'not-enabled',
        ...(cluster.guitarEarAttackDistance !== undefined
          ? { guitarEarAttackDistance: cluster.guitarEarAttackDistance }
          : {}),
      });
    }
  });

  playable.sort((a, b) => a.start - b.start || a.guitar.string - b.guitar.string);
  const highConfidence = playable.filter(note => note.confidence >= 0.67).length;
  const uncertain = playable.filter(note => note.confidence < 0.48).length;
  const averageConfidence = playable.length
    ? playable.reduce((sum, note) => sum + note.confidence, 0) / playable.length
    : 0;
  const sensitiveOnly = merged.filter(note => note.detectionSources.length === 1 && note.detectionSources[0] === 'sensitive').length;

  return {
    engine: gated.stats.enabled
      ? 'guitar-ear-v0.2d+basic-pitch-ensemble-v2-browser'
      : 'guitar-basic-pitch-ensemble-v1.1-browser',
    notes: playable,
    summary: {
      rawByPass: Object.fromEntries(PASSES.map((pass, index) => [pass.id, passResults[index].length])),
      mergedCandidates: merged.length,
      teachingCandidates: teachingCandidates.length,
      rejectedAsNoise: merged.length - teachingCandidates.length,
      sensitiveOnly,
      playableNotes: playable.length,
      onsetGroups: gated.clusters.length,
      highConfidence,
      uncertain,
      averageConfidence,
      guitarEar: compactGuitarEar(guitarEar),
      guitarEarGate: gated.stats,
    },
  };
}
