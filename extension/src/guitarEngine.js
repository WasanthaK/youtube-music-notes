import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

const STRINGS = [
  { number: 1, name: 'e', openMidi: 64 },
  { number: 2, name: 'B', openMidi: 59 },
  { number: 3, name: 'G', openMidi: 55 },
  { number: 4, name: 'D', openMidi: 50 },
  { number: 5, name: 'A', openMidi: 45 },
  { number: 6, name: 'E', openMidi: 40 },
];

const GUITAR_MIN_HZ = 80;
const GUITAR_MAX_HZ = 1320;
const MAX_FRET = 24;
const ONSET_CLUSTER_SECONDS = 0.065;
const SAME_NOTE_MERGE_SECONDS = 0.055;

// v1.2 teaching-view filters. These are intentionally conservative and keep
// strong/consensus notes even in dense passages. Raw v1.1 metrics are retained
// in the summary so every benchmark is an A/B test on identical audio.
const HARMONIC_WINDOW_SECONDS = 0.045;
const MICRO_ONSET_SECONDS = 0.085;
const MAX_FRETTED_SPREAD_V12 = 5;
const LEARNER_NOTES_PER_SECOND = 18;

const PASSES = [
  { id: 'strict', onset: 0.40, frame: 0.28, minFrames: 5, energyTolerance: 10 },
  { id: 'balanced', onset: 0.30, frame: 0.22, minFrames: 4, energyTolerance: 11 },
  { id: 'sensitive', onset: 0.22, frame: 0.17, minFrames: 3, energyTolerance: 12 },
];

const clamp01 = value => Math.max(0, Math.min(1, value));
const clone2d = matrix => matrix.map(row => row.slice());
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
    end: note.startTimeSeconds + note.durationSeconds,
    duration: note.durationSeconds,
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
    bucket.anchorStart = bucket.detections.reduce((sum, n) => sum + n.start, 0) / bucket.detections.length;
  }

  return buckets.map(bucket => {
    const detections = bucket.detections;
    const best = detections.reduce((a, b) => b.amplitude > a.amplitude ? b : a);
    const sources = [...new Set(detections.map(n => n.pass))];
    const support = sources.length;
    const weightTotal = detections.reduce((sum, n) => sum + Math.max(0.05, n.amplitude), 0);
    const weightedStart = detections.reduce((sum, n) => sum + n.start * Math.max(0.05, n.amplitude), 0) / weightTotal;
    const weightedEnd = detections.reduce((sum, n) => sum + n.end * Math.max(0.05, n.amplitude), 0) / weightTotal;
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
      pitchBends: best.pitchBends,
    };
  }).filter(note => note.duration >= 0.04)
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
}

function isTeachingCandidate(note) {
  const sources = new Set(note.detectionSources);
  const strict = sources.has('strict');
  const balanced = sources.has('balanced');
  const sensitive = sources.has('sensitive');

  if (sources.size >= 2) return note.confidence >= 0.38 && note.duration >= 0.05;
  if (strict) return note.amplitude >= 0.38 && note.duration >= 0.06;
  if (balanced) return note.amplitude >= 0.46 && note.duration >= 0.08;
  if (sensitive) return note.amplitude >= 0.66 && note.duration >= 0.14;
  return false;
}

function suppressLikelyHarmonics(notes) {
  const kept = [];
  let rejected = 0;

  for (const note of notes) {
    const likelyHarmonic = kept.some(lower => {
      const dt = Math.abs(lower.start - note.start);
      const interval = note.midi - lower.midi;
      if (dt > HARMONIC_WINDOW_SECONDS || ![12, 19, 24].includes(interval)) return false;

      // Do not delete a legitimate octave/fifth merely because the interval is harmonic.
      // The upper note must also be materially weaker and no longer than the lower event.
      return note.confidence <= lower.confidence - 0.10 &&
        note.amplitude <= lower.amplitude * 0.92 &&
        note.duration <= lower.duration * 1.15;
    });

    if (likelyHarmonic) rejected += 1;
    else kept.push(note);
  }

  return { notes: kept, rejected };
}

function positionCandidates(midi) {
  return STRINGS.map(string => ({
    string: string.number,
    stringName: string.name,
    fret: midi - string.openMidi,
  })).filter(position => position.fret >= 0 && position.fret <= MAX_FRET);
}

function assignmentStats(assignment, previousHandPosition) {
  const fretted = assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const minFret = fretted.length ? Math.min(...fretted) : 0;
  const hand = fretted.length ? median(fretted) : previousHandPosition;
  const spread = fretted.length > 1 ? maxFret - minFret : 0;
  return { fretted, hand, spread };
}

function assignmentCost(assignment, previousHandPosition) {
  const { hand, spread } = assignmentStats(assignment, previousHandPosition);

  let cost = assignment.reduce((sum, item) => {
    const fret = item.position.fret;
    const openBonus = fret === 0 ? -0.35 : 0;
    const highFretPenalty = fret > 12 ? (fret - 12) * 0.08 : 0;
    return sum + fret * 0.04 + openBonus + highFretPenalty;
  }, 0);

  cost += spread * 0.55;
  cost += Math.abs(hand - previousHandPosition) * 0.22;
  return cost;
}

function solveAssignment(notes, previousHandPosition, maxFrettedSpread = Infinity) {
  const candidateLists = notes.map(note => ({ note, positions: positionCandidates(note.midi) }));
  if (candidateLists.some(item => !item.positions.length)) return null;

  let best = null;
  function visit(index, usedStrings, assignment) {
    if (index === candidateLists.length) {
      const { spread } = assignmentStats(assignment, previousHandPosition);
      if (assignment.length >= 3 && spread > maxFrettedSpread) return;
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

function selectChordCore(cluster) {
  const sorted = [...cluster].sort((a, b) => b.confidence - a.confidence);
  if (sorted.length <= 4) return sorted;

  const average = sorted.reduce((sum, note) => sum + note.confidence, 0) / sorted.length;
  const strongest = sorted[0].confidence;
  const limit = average >= 0.62 ? 6 : average >= 0.56 ? 5 : 4;
  const evidenceFloor = Math.max(0.44, strongest - 0.20);
  const selected = sorted
    .filter(note => note.confidence >= evidenceFloor || note.detectionSources.length === 3)
    .slice(0, limit);

  return selected.length ? selected : sorted.slice(0, 1);
}

function assignClusterToGuitar(cluster, previousHandPosition, v12 = false) {
  const originalCount = cluster.length;
  let working = v12 ? selectChordCore(cluster) : [...cluster].sort((a, b) => b.confidence - a.confidence);
  if (working.length > 6) working = working.slice(0, 6);

  const maxSpread = v12 ? MAX_FRETTED_SPREAD_V12 : Infinity;
  let solution = solveAssignment(working, previousHandPosition, maxSpread);
  while (!solution && working.length > 1) {
    working = working.slice(0, -1);
    solution = solveAssignment(working, previousHandPosition, maxSpread);
  }

  if (!solution) {
    return { notes: [], handPosition: previousHandPosition, rejected: originalCount };
  }

  const frets = solution.assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const handPosition = frets.length ? median(frets) : previousHandPosition;
  const assigned = solution.assignment.map(item => ({ ...item.note, guitar: item.position }));
  return { notes: assigned, handPosition, rejected: originalCount - assigned.length };
}

function groupIntoOnsets(notes) {
  const clusters = [];
  for (const note of notes) {
    const last = clusters[clusters.length - 1];
    if (!last || note.start - last.anchor > ONSET_CLUSTER_SECONDS) {
      clusters.push({ anchor: note.start, notes: [note] });
    } else {
      last.notes.push(note);
      last.anchor = last.notes.reduce((sum, n) => sum + n.start, 0) / last.notes.length;
    }
  }
  return clusters;
}

function clusterStrength(cluster) {
  const confidences = cluster.notes.map(note => note.confidence);
  const maxConfidence = Math.max(...confidences);
  const meanConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  const meanConsensus = cluster.notes.reduce((sum, note) => sum + note.consensus, 0) / cluster.notes.length;
  return (maxConfidence * 0.55) + (meanConfidence * 0.30) + (meanConsensus * 0.15);
}

function debounceWeakOnsets(clusters) {
  const kept = [];
  let rejectedNotes = 0;
  let rejectedGroups = 0;

  for (const cluster of clusters) {
    const previous = kept[kept.length - 1];
    if (!previous || cluster.anchor - previous.anchor >= MICRO_ONSET_SECONDS) {
      kept.push(cluster);
      continue;
    }

    const previousStrength = clusterStrength(previous);
    const currentStrength = clusterStrength(cluster);

    if (cluster.notes.length <= 2 && currentStrength + 0.12 < previousStrength) {
      rejectedNotes += cluster.notes.length;
      rejectedGroups += 1;
      continue;
    }

    if (previous.notes.length <= 2 && previousStrength + 0.12 < currentStrength) {
      kept.pop();
      rejectedNotes += previous.notes.length;
      rejectedGroups += 1;
      kept.push(cluster);
      continue;
    }

    kept.push(cluster);
  }

  return { clusters: kept, rejectedNotes, rejectedGroups };
}

function bendSemitones(pitchBends) {
  if (!pitchBends?.length) return 0;
  const absolutePeak = pitchBends.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  return Math.round((absolutePeak / 3) * 10) / 10;
}

function assignClusters(clusters, v12 = false) {
  const playable = [];
  let previousHandPosition = 3;
  let rejected = 0;

  clusters.forEach((cluster, chordId) => {
    const result = assignClusterToGuitar(cluster.notes, previousHandPosition, v12);
    previousHandPosition = result.handPosition;
    rejected += result.rejected;
    result.notes.forEach(note => playable.push({
      ...note,
      chordId,
      bendSemitones: bendSemitones(note.pitchBends),
    }));
  });

  playable.sort((a, b) => a.start - b.start || a.guitar.string - b.guitar.string);
  return { notes: playable, rejected };
}

function applyLearnerDensityGuard(notes) {
  const bins = new Map();
  for (const note of notes) {
    const second = Math.floor(note.start);
    if (!bins.has(second)) bins.set(second, []);
    bins.get(second).push(note);
  }

  const rejected = new Set();
  for (const binNotes of bins.values()) {
    if (binNotes.length <= LEARNER_NOTES_PER_SECOND) continue;

    const strongestByChord = new Map();
    for (const note of binNotes) {
      const current = strongestByChord.get(note.chordId);
      if (!current || note.confidence > current.confidence) strongestByChord.set(note.chordId, note);
    }
    const protectedNotes = new Set([
      ...strongestByChord.values(),
      ...binNotes.filter(note => note.confidence >= 0.67),
    ]);

    const removable = binNotes
      .filter(note => !protectedNotes.has(note))
      .sort((a, b) => a.confidence - b.confidence || a.duration - b.duration);

    let remaining = binNotes.length;
    for (const note of removable) {
      if (remaining <= LEARNER_NOTES_PER_SECOND) break;
      rejected.add(note);
      remaining -= 1;
    }
  }

  return {
    notes: notes.filter(note => !rejected.has(note)),
    rejected: rejected.size,
  };
}

function confidenceStats(notes) {
  return {
    highConfidence: notes.filter(note => note.confidence >= 0.67).length,
    uncertain: notes.filter(note => note.confidence < 0.48).length,
    averageConfidence: notes.length
      ? notes.reduce((sum, note) => sum + note.confidence, 0) / notes.length
      : 0,
  };
}

export function buildGuitarTranscription(frames, onsets, contours) {
  const passResults = PASSES.map(pass => decodePass(frames, onsets, contours, pass));
  const merged = mergePassDetections(passResults);
  const teachingCandidates = merged.filter(isTeachingCandidate);

  // Preserve the exact v1.1 path as an internal control for every sample.
  const v11Clusters = groupIntoOnsets(teachingCandidates);
  const v11Playable = assignClusters(v11Clusters, false).notes;

  // v1.2: remove weak overtone-like duplicates, debounce weak micro-onsets,
  // require more plausible chord cores/hand spread, then trim only weak extras
  // in extremely dense one-second windows.
  const harmonic = suppressLikelyHarmonics(teachingCandidates);
  const harmonicClusters = groupIntoOnsets(harmonic.notes);
  const debounced = debounceWeakOnsets(harmonicClusters);
  const v12Assigned = assignClusters(debounced.clusters, true);
  const densityGuard = applyLearnerDensityGuard(v12Assigned.notes);
  const playable = densityGuard.notes;

  const stats = confidenceStats(playable);
  const v11Stats = confidenceStats(v11Playable);
  const sensitiveOnly = merged.filter(note => note.detectionSources.length === 1 && note.detectionSources[0] === 'sensitive').length;

  return {
    engine: 'guitar-basic-pitch-ensemble-v1.2',
    notes: playable,
    summary: {
      rawByPass: Object.fromEntries(PASSES.map((pass, index) => [pass.id, passResults[index].length])),
      mergedCandidates: merged.length,
      // Keep historical v1.1 filter semantics in these fields for longitudinal comparison.
      teachingCandidates: teachingCandidates.length,
      rejectedAsNoise: merged.length - teachingCandidates.length,
      sensitiveOnly,
      onsetGroups: v11Clusters.length,
      v11PlayableNotes: v11Playable.length,
      v11HighConfidence: v11Stats.highConfidence,
      v11Uncertain: v11Stats.uncertain,
      v11AverageConfidence: v11Stats.averageConfidence,
      harmonicRejected: harmonic.rejected,
      microOnsetRejectedNotes: debounced.rejectedNotes,
      microOnsetRejectedGroups: debounced.rejectedGroups,
      v12OnsetGroups: debounced.clusters.length,
      chordPlausibilityRejected: v12Assigned.rejected,
      preDensityPlayableNotes: v12Assigned.notes.length,
      densityRejected: densityGuard.rejected,
      learnerNotesPerSecondCap: LEARNER_NOTES_PER_SECOND,
      playableNotes: playable.length,
      highConfidence: stats.highConfidence,
      uncertain: stats.uncertain,
      averageConfidence: stats.averageConfidence,
    },
  };
}
