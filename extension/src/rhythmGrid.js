function supportRank(v) {
  if (v === 'attack') return 3;
  if (v === 'presence') return 2;
  if (v === 'uncertain-presence') return 1;
  return 0;
}

function clusterScore(cluster, strokeTime) {
  const notes = cluster.notes || [];
  const confidence = notes.reduce((m, n) => Math.max(m, Number(n.confidence || 0)), 0);
  const consensus = notes.reduce((m, n) => Math.max(m, Number(n.consensus || 0)), 0);
  const timingError = Math.abs(Number(cluster.anchor || 0) - strokeTime);
  return supportRank(cluster.guitarEarSupport) * 0.30 + consensus * 0.30 + confidence * 0.35 - timingError * 0.30;
}

function noteScore(note) {
  return Number(note.confidence || 0) * 0.55
    + Number(note.consensus || 0) * 0.35
    + Number(note.amplitude || 0) * 0.10;
}

function mergeStrokeNotes(clusters, strokeTime) {
  const byMidi = new Map();

  for (const cluster of clusters) {
    for (const note of cluster.notes || []) {
      const midi = Number(note.midi);
      if (!Number.isFinite(midi)) continue;

      const old = byMidi.get(midi);
      const sources = new Set([
        ...(old?.detectionSources || []),
        ...(note.detectionSources || []),
      ]);
      const best = !old || noteScore(note) > noteScore(old) ? note : old;
      const maxEnd = Math.max(
        Number(old?.end || strokeTime + 0.04),
        Number(note.end || note.start || strokeTime + 0.04),
        strokeTime + 0.04,
      );

      byMidi.set(midi, {
        ...best,
        start: strokeTime,
        end: maxEnd,
        duration: Math.max(0.04, maxEnd - strokeTime),
        confidence: Math.max(Number(old?.confidence || 0), Number(note.confidence || 0)),
        consensus: Math.max(Number(old?.consensus || 0), Number(note.consensus || 0)),
        amplitude: Math.max(Number(old?.amplitude || 0), Number(note.amplitude || 0)),
        detectionSources: [...sources],
      });
    }
  }

  return [...byMidi.values()]
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || Number(a.midi) - Number(b.midi));
}

function mergeStrokeClusters(clusters, strokeTime, pulseIndex) {
  const representative = clusters.reduce((best, candidate) => (
    !best || clusterScore(candidate, strokeTime) > clusterScore(best, strokeTime)
      ? candidate
      : best
  ), null);

  const notes = mergeStrokeNotes(clusters, strokeTime);
  const strongestSupport = clusters.reduce((best, cluster) => (
    supportRank(cluster.guitarEarSupport) > supportRank(best) ? cluster.guitarEarSupport : best
  ), null);
  const attackDistances = clusters
    .map(cluster => Number(cluster.guitarEarAttackDistance))
    .filter(Number.isFinite);

  return {
    ...representative,
    anchor: strokeTime,
    notes,
    guitarEarSupport: strongestSupport || representative?.guitarEarSupport,
    ...(attackDistances.length ? { guitarEarAttackDistance: Math.min(...attackDistances) } : {}),
    rhythmSlot: pulseIndex,
    rhythmSlotTime: strokeTime,
    rhythmBeatIndex: pulseIndex,
    rhythmSubdivision: 0,
    rhythmErrorSeconds: Number(representative?.anchor || strokeTime) - strokeTime,
    rhythmMergedClusterCount: clusters.length,
  };
}

export function applyTempoGrid(clusters, tempo) {
  const preCount = clusters.length;
  if (!tempo?.available || !Number.isFinite(Number(tempo.pulseBpm)) || Number(tempo.confidence || 0) < 0.25) {
    return {
      clusters,
      stats: {
        enabled: false,
        mode: 'disabled',
        preRhythmOnsetGroups: preCount,
        postRhythmOnsetGroups: preCount,
        mergedByRhythm: 0,
        slotsPerPulse: null,
        slotSeconds: null,
        onsetGroupsPerPulse: null,
      },
    };
  }

  const pulseBpm = Number(tempo.pulseBpm);
  const pulseSeconds = 60 / pulseBpm;
  const phase = Number(tempo.phaseSeconds || 0);
  const byPulse = new Map();

  // A guitar stroke is a musical event, not every Basic Pitch onset candidate.
  // Quantize to one stroke per detected pulse. All candidates landing on the
  // same pulse are merged into one chord/melody event rather than emitted as
  // separate attacks at half-pulse subdivisions.
  for (const cluster of clusters) {
    const anchor = Number(cluster.anchor || 0);
    const pulseIndex = Math.round((anchor - phase) / pulseSeconds);
    if (!byPulse.has(pulseIndex)) byPulse.set(pulseIndex, []);
    byPulse.get(pulseIndex).push(cluster);
  }

  const selected = [...byPulse.entries()]
    .map(([pulseIndex, pulseClusters]) => {
      const rawStrokeTime = phase + Number(pulseIndex) * pulseSeconds;
      const strokeTime = Math.max(0, rawStrokeTime);
      return mergeStrokeClusters(pulseClusters, strokeTime, Number(pulseIndex));
    })
    .filter(cluster => cluster.notes?.length)
    .sort((a, b) => Number(a.anchor) - Number(b.anchor));

  const pulseCount = Math.max(1, (Number(tempo.durationSeconds || 0) * pulseBpm) / 60);
  const mergedInputGroups = selected.reduce(
    (sum, cluster) => sum + Math.max(0, Number(cluster.rhythmMergedClusterCount || 1) - 1),
    0,
  );

  return {
    clusters: selected,
    stats: {
      enabled: true,
      mode: 'tempo-stroke-merge-v2',
      preRhythmOnsetGroups: preCount,
      postRhythmOnsetGroups: selected.length,
      mergedByRhythm: preCount - selected.length,
      mergedInputGroups,
      slotsPerPulse: 1,
      slotSeconds: pulseSeconds,
      pulseBpm,
      phaseSeconds: phase,
      maxOneStrokePerPulse: true,
      onsetGroupsPerPulse: selected.length / pulseCount,
      averageInputGroupsPerStroke: selected.length ? preCount / selected.length : 0,
    },
  };
}
