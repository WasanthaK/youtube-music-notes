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
    const confidence = clamp01((best.amplitude * 0.65) + (consensus * 0.35));

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
  }).filter(note => {
    if (note.duration < 0.04) return false;
    if (note.consensus >= 2 / 3) return true;
    if (note.amplitude >= 0.52) return true;
    return note.duration >= 0.16 && note.confidence >= 0.34;
  }).sort((a, b) => a.start - b.start || a.midi - b.midi);
}

function positionCandidates(midi) {
  return STRINGS.map(string => ({
    string: string.number,
    stringName: string.name,
    fret: midi - string.openMidi,
  })).filter(position => position.fret >= 0 && position.fret <= MAX_FRET);
}

function assignmentCost(assignment, previousHandPosition) {
  const fretted = assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const minFret = fretted.length ? Math.min(...fretted) : 0;
  const hand = fretted.length ? median(fretted) : previousHandPosition;
  const spread = fretted.length > 1 ? maxFret - minFret : 0;

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
  let working = [...cluster].sort((a, b) => b.confidence - a.confidence);
  if (working.length > 6) working = working.slice(0, 6);

  let solution = solveAssignment(working, previousHandPosition);
  while (!solution && working.length > 1) {
    working = working.slice(0, -1);
    solution = solveAssignment(working, previousHandPosition);
  }

  if (!solution) return { notes: [], handPosition: previousHandPosition };

  const frets = solution.assignment.map(item => item.position.fret).filter(fret => fret > 0);
  const handPosition = frets.length ? median(frets) : previousHandPosition;
  const assigned = solution.assignment.map(item => ({
    ...item.note,
    guitar: item.position,
  }));

  return { notes: assigned, handPosition };
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

function bendSemitones(pitchBends) {
  if (!pitchBends?.length) return 0;
  const absolutePeak = pitchBends.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  return Math.round((absolutePeak / 3) * 10) / 10;
}

export function buildGuitarTranscription(frames, onsets, contours) {
  const passResults = PASSES.map(pass => decodePass(frames, onsets, contours, pass));
  const merged = mergePassDetections(passResults);
  const clusters = groupIntoOnsets(merged);

  const playable = [];
  let previousHandPosition = 3;

  clusters.forEach((cluster, chordId) => {
    const { notes, handPosition } = assignClusterToGuitar(cluster.notes, previousHandPosition);
    previousHandPosition = handPosition;
    notes.forEach(note => {
      playable.push({
        ...note,
        chordId,
        bendSemitones: bendSemitones(note.pitchBends),
      });
    });
  });

  playable.sort((a, b) => a.start - b.start || a.guitar.string - b.guitar.string);

  const highConfidence = playable.filter(note => note.confidence >= 0.67).length;
  const uncertain = playable.filter(note => note.confidence < 0.45).length;
  const averageConfidence = playable.length
    ? playable.reduce((sum, note) => sum + note.confidence, 0) / playable.length
    : 0;

  return {
    engine: 'guitar-basic-pitch-ensemble-v1',
    notes: playable,
    summary: {
      rawByPass: Object.fromEntries(PASSES.map((pass, index) => [pass.id, passResults[index].length])),
      mergedCandidates: merged.length,
      playableNotes: playable.length,
      onsetGroups: clusters.length,
      highConfidence,
      uncertain,
      averageConfidence,
    },
  };
}

export function renderGuitarTab(notes, maxGroups = 80) {
  const labels = ['e|', 'B|', 'G|', 'D|', 'A|', 'E|'];
  const groups = [];
  for (const note of notes) {
    let group = groups.find(item => item.id === note.chordId);
    if (!group) {
      group = { id: note.chordId, notes: [] };
      groups.push(group);
    }
    group.notes.push(note);
  }

  for (const group of groups.slice(0, maxGroups)) {
    const tokens = Array(6).fill('---');
    for (const note of group.notes) {
      const suffix = note.bendSemitones >= 0.5 ? 'b' : '';
      const text = `${note.guitar.fret}${suffix}`;
      tokens[note.guitar.string - 1] = text.padEnd(3, '-').slice(0, 3);
    }
    for (let i = 0; i < 6; i++) labels[i] += tokens[i];
  }

  return labels.join('\n');
}
