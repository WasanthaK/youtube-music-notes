// Musical interpretation layer for guitar transcription.
//
// This module intentionally does not detect new notes. It takes the candidate
// stroke/lead clusters produced by Basic Pitch + Guitar Ear + the tempo grid and
// reduces them to gestures that a guitarist could plausibly play.

const SAME_NOTE_REARTICULATION_SECONDS = 0.22;
const SAME_CHORD_REARTICULATION_SECONDS = 0.23;
const MAX_CHORD_NOTES = 5;
const MAX_CHORD_PITCH_CLASSES = 4;

const clamp01 = value => Math.max(0, Math.min(1, Number(value || 0)));
const pitchClass = midi => ((Number(midi) % 12) + 12) % 12;

function supportRank(value) {
  if (value === 'attack') return 3;
  if (value === 'presence') return 2;
  if (value === 'uncertain-presence') return 1;
  return 0;
}

function noteEvidence(note) {
  return (
    clamp01(note.confidence) * 0.58 +
    clamp01(note.consensus) * 0.30 +
    clamp01(note.amplitude) * 0.12
  );
}

function continuityScore(midi, previousMidi, elapsedSeconds) {
  if (!Number.isFinite(previousMidi) || elapsedSeconds > 1.0) return 0;
  const distance = Math.abs(Number(midi) - previousMidi);
  if (distance === 0) return 0.24;
  if (distance <= 2) return 0.18;
  if (distance <= 5) return 0.12;
  if (distance <= 7) return 0.07;
  if (distance <= 12) return 0;
  return -0.18 - Math.min(0.30, (distance - 12) * 0.025);
}

function harmonicStackLike(notes) {
  if (notes.length < 2) return false;
  const sorted = [...notes].sort((a, b) => Number(a.midi) - Number(b.midi));
  const base = Number(sorted[0].midi);
  const harmonicIntervals = new Set([0, 12, 19, 24, 28, 31, 36]);
  const harmonicCount = sorted.filter(note => harmonicIntervals.has(Number(note.midi) - base)).length;
  const distinctPitchClasses = new Set(sorted.map(note => pitchClass(note.midi))).size;
  return distinctPitchClasses <= 2 && harmonicCount / sorted.length >= 0.67;
}

function classifyGesture(cluster) {
  const notes = cluster.notes || [];
  if (notes.length <= 1) return 'lead';

  const distinctPitchClasses = new Set(notes.map(note => pitchClass(note.midi))).size;
  if (harmonicStackLike(notes)) return 'lead';

  if (notes.length === 2) {
    const [a, b] = [...notes].sort((x, y) => Number(x.midi) - Number(y.midi));
    const interval = Math.abs(Number(b.midi) - Number(a.midi));
    const bothStrong = Math.min(Number(a.confidence || 0), Number(b.confidence || 0)) >= 0.64;
    return bothStrong && interval <= 12 ? 'double-stop' : 'lead';
  }

  return distinctPitchClasses >= 3 ? 'chord' : 'lead';
}

function chooseLeadNote(notes, previousMidi, elapsedSeconds) {
  if (!notes.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const note of notes) {
    let score = noteEvidence(note) + continuityScore(note.midi, previousMidi, elapsedSeconds);
    if (Number.isFinite(previousMidi)) {
      const distance = Math.abs(Number(note.midi) - previousMidi);
      if (pitchClass(note.midi) === pitchClass(previousMidi) && distance >= 12 && elapsedSeconds < 0.35) {
        score -= 0.28;
      }
    }
    if (score > bestScore) {
      best = note;
      bestScore = score;
    }
  }
  return best;
}

function chooseDoubleStop(notes, previousMidi, elapsedSeconds) {
  const ranked = [...notes]
    .map(note => ({ note, score: noteEvidence(note) + continuityScore(note.midi, previousMidi, elapsedSeconds) }))
    .sort((a, b) => b.score - a.score);
  if (ranked.length < 2) return ranked.length ? [ranked[0].note] : [];

  const first = ranked[0].note;
  const second = ranked.find(item => {
    const interval = Math.abs(Number(item.note.midi) - Number(first.midi));
    return item.note !== first && interval > 0 && interval <= 12;
  })?.note;
  return second ? [first, second].sort((a, b) => Number(a.midi) - Number(b.midi)) : [first];
}

function chooseChordVoicing(notes) {
  if (!notes.length) return { notes: [], removedDuplicatePitchClasses: 0 };
  const sorted = [...notes].sort((a, b) => Number(a.midi) - Number(b.midi));
  const bass = sorted[0];
  const byPitchClass = new Map();

  for (const note of notes) {
    const pc = pitchClass(note.midi);
    const previous = byPitchClass.get(pc);
    if (!previous || noteEvidence(note) > noteEvidence(previous)) byPitchClass.set(pc, note);
  }

  // The bass anchors the perceived chord even when a higher octave of the same
  // pitch class has slightly stronger spectral confidence.
  if (Number(bass.confidence || 0) >= 0.48) byPitchClass.set(pitchClass(bass.midi), bass);

  let selected = [...byPitchClass.values()]
    .sort((a, b) => noteEvidence(b) - noteEvidence(a))
    .slice(0, MAX_CHORD_PITCH_CLASSES);

  if (bass && !selected.includes(bass) && Number(bass.confidence || 0) >= 0.52) {
    selected.push(bass);
  }

  // A guitar chord may legitimately double one pitch class at the octave, but
  // require unusually strong consensus before preserving that doubling.
  const duplicateCandidates = notes
    .filter(note => !selected.includes(note))
    .filter(note => Number(note.confidence || 0) >= 0.80 && Number(note.consensus || 0) >= 0.66)
    .sort((a, b) => noteEvidence(b) - noteEvidence(a));

  for (const note of duplicateCandidates) {
    if (selected.length >= MAX_CHORD_NOTES) break;
    const samePc = selected.find(existing => pitchClass(existing.midi) === pitchClass(note.midi));
    if (!samePc) continue;
    const octaveDistance = Math.abs(Number(note.midi) - Number(samePc.midi));
    if (octaveDistance === 12 && supportRank(note.guitarEarSupport) >= 2) {
      selected.push(note);
      break; // at most one octave doubling in a decoded voicing
    }
  }

  selected = [...new Set(selected)]
    .sort((a, b) => Number(a.midi) - Number(b.midi))
    .slice(0, MAX_CHORD_NOTES);

  return {
    notes: selected,
    removedDuplicatePitchClasses: Math.max(0, notes.length - selected.length),
  };
}

function pitchClassSet(notes) {
  return new Set((notes || []).map(note => pitchClass(note.midi)));
}

function jaccardPitchClass(a, b) {
  const left = pitchClassSet(a);
  const right = pitchClassSet(b);
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, new Set([...left, ...right]).size);
}

function cloneCluster(cluster, notes, role) {
  return {
    ...cluster,
    notes: notes.map(note => ({ ...note, musicalRole: role })),
    musicalRole: role,
  };
}

function applyArticulation(clusters, pulseSeconds) {
  for (let i = 0; i < clusters.length; i += 1) {
    const cluster = clusters[i];
    const next = clusters[i + 1];
    const start = Number(cluster.anchor || 0);
    const nextStart = Number(next?.anchor);
    const gap = Number.isFinite(nextStart) ? Math.max(0.05, nextStart - start) : pulseSeconds;

    if (cluster.musicalRole === 'lead') {
      const sustain = Math.max(0.20, Math.min(0.85, gap * 0.92, pulseSeconds * 1.8));
      cluster.notes = cluster.notes.map(note => ({
        ...note,
        start,
        end: Math.max(start + 0.08, Math.min(Number(note.end || start + sustain), start + sustain)),
        duration: Math.max(0.08, Math.min(Number(note.end || start + sustain), start + sustain) - start),
      }));
    } else {
      const decay = Math.max(0.13, Math.min(0.38, gap * 0.72, pulseSeconds * 0.78));
      cluster.notes = cluster.notes.map(note => ({
        ...note,
        start,
        end: start + decay,
        duration: decay,
      }));
    }
  }
  return clusters;
}

export function decodeGuitarPerformance(clusters, tempo = null) {
  const ordered = [...(clusters || [])].sort((a, b) => Number(a.anchor) - Number(b.anchor));
  const preGroups = ordered.length;
  const preNotes = ordered.reduce((sum, cluster) => sum + (cluster.notes?.length || 0), 0);
  const pulseSeconds = Number.isFinite(Number(tempo?.pulseBpm)) && Number(tempo.pulseBpm) > 0
    ? 60 / Number(tempo.pulseBpm)
    : 0.42;

  const decoded = [];
  let previousLeadMidi = null;
  let previousLeadTime = -Infinity;
  let duplicatePitchClassRemoved = 0;
  let sameNoteRetriggersMerged = 0;
  let octaveSwitchesSuppressed = 0;
  let chordRetriggersMerged = 0;

  for (const original of ordered) {
    const anchor = Number(original.anchor || 0);
    const role = classifyGesture(original);
    const elapsedLead = anchor - previousLeadTime;
    let notes = [];

    if (role === 'chord') {
      const chord = chooseChordVoicing(original.notes || []);
      notes = chord.notes;
      duplicatePitchClassRemoved += chord.removedDuplicatePitchClasses;
    } else if (role === 'double-stop') {
      notes = chooseDoubleStop(original.notes || [], previousLeadMidi, elapsedLead);
    } else {
      const best = chooseLeadNote(original.notes || [], previousLeadMidi, elapsedLead);
      if (best) notes = [best];
    }

    if (!notes.length) continue;

    const cluster = cloneCluster(original, notes, role);
    const previous = decoded[decoded.length - 1];
    const gap = previous ? anchor - Number(previous.anchor || 0) : Infinity;
    const newAttack = original.guitarEarSupport === 'attack';

    if (previous && !newAttack && gap <= SAME_NOTE_REARTICULATION_SECONDS && role !== 'chord' && previous.musicalRole !== 'chord') {
      const prevMidi = Number(previous.notes?.[0]?.midi);
      const currentMidi = Number(cluster.notes?.[0]?.midi);
      if (Number.isFinite(prevMidi) && Number.isFinite(currentMidi)) {
        if (prevMidi === currentMidi) {
          previous.notes[0].end = Math.max(Number(previous.notes[0].end || anchor), Number(cluster.notes[0].end || anchor));
          previous.notes[0].duration = Math.max(0.08, previous.notes[0].end - Number(previous.anchor || 0));
          sameNoteRetriggersMerged += 1;
          continue;
        }
        if (pitchClass(prevMidi) === pitchClass(currentMidi) && Math.abs(prevMidi - currentMidi) >= 12) {
          octaveSwitchesSuppressed += 1;
          continue;
        }
      }
    }

    if (
      previous &&
      !newAttack &&
      role === 'chord' &&
      previous.musicalRole === 'chord' &&
      gap <= SAME_CHORD_REARTICULATION_SECONDS &&
      jaccardPitchClass(previous.notes, cluster.notes) >= 0.60
    ) {
      for (const note of cluster.notes) {
        const match = previous.notes.find(existing => Number(existing.midi) === Number(note.midi));
        if (match) {
          match.end = Math.max(Number(match.end || anchor), Number(note.end || anchor));
          match.duration = Math.max(0.08, match.end - Number(previous.anchor || 0));
        }
      }
      chordRetriggersMerged += 1;
      continue;
    }

    decoded.push(cluster);
    if (role !== 'chord' && cluster.notes.length) {
      previousLeadMidi = Number(cluster.notes[0].midi);
      previousLeadTime = anchor;
    }
  }

  applyArticulation(decoded, pulseSeconds);

  const postNotes = decoded.reduce((sum, cluster) => sum + (cluster.notes?.length || 0), 0);
  const roleCounts = decoded.reduce((acc, cluster) => {
    acc[cluster.musicalRole] = (acc[cluster.musicalRole] || 0) + 1;
    return acc;
  }, {});

  return {
    clusters: decoded,
    stats: {
      enabled: true,
      mode: 'guitar-performance-decoder-v1',
      preMusicalOnsetGroups: preGroups,
      postMusicalOnsetGroups: decoded.length,
      preMusicalNotes: preNotes,
      postMusicalNotes: postNotes,
      duplicatePitchClassRemoved,
      sameNoteRetriggersMerged,
      octaveSwitchesSuppressed,
      chordRetriggersMerged,
      roleCounts,
      pulseSeconds,
    },
  };
}
