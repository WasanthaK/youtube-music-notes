function supportRank(v) {
  if (v === 'attack') return 3;
  if (v === 'presence') return 2;
  if (v === 'uncertain-presence') return 1;
  return 0;
}

function clusterScore(cluster, slotTime) {
  const notes = cluster.notes || [];
  const confidence = notes.reduce((m, n) => Math.max(m, Number(n.confidence || 0)), 0);
  const consensus = notes.reduce((m, n) => Math.max(m, Number(n.consensus || 0)), 0);
  const timingError = Math.abs(Number(cluster.anchor || 0) - slotTime);
  return supportRank(cluster.guitarEarSupport) * 0.30 + consensus * 0.30 + confidence * 0.35 - timingError * 0.30;
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
  const slotsPerPulse = Math.max(1, Number(tempo.suggestedSlotsPerPulse || 2));
  const slotSeconds = pulseSeconds / slotsPerPulse;
  const phase = Number(tempo.phaseSeconds || 0);
  const bySlot = new Map();

  for (const cluster of clusters) {
    const anchor = Number(cluster.anchor || 0);
    const slotIndex = Math.round((anchor - phase) / slotSeconds);
    const slotTime = phase + slotIndex * slotSeconds;
    const candidate = {
      ...cluster,
      rhythmSlot: slotIndex,
      rhythmSlotTime: slotTime,
      rhythmBeatIndex: Math.floor(slotIndex / slotsPerPulse),
      rhythmSubdivision: ((slotIndex % slotsPerPulse) + slotsPerPulse) % slotsPerPulse,
      rhythmErrorSeconds: anchor - slotTime,
    };
    const old = bySlot.get(slotIndex);
    if (!old || clusterScore(candidate, slotTime) > clusterScore(old, slotTime)) bySlot.set(slotIndex, candidate);
  }

  const selected = [...bySlot.values()].sort((a, b) => Number(a.anchor) - Number(b.anchor));
  const pulseCount = Math.max(1, (Number(tempo.durationSeconds || 0) * pulseBpm) / 60);
  return {
    clusters: selected,
    stats: {
      enabled: true,
      mode: 'tempo-grid-v1',
      preRhythmOnsetGroups: preCount,
      postRhythmOnsetGroups: selected.length,
      mergedByRhythm: preCount - selected.length,
      slotsPerPulse,
      slotSeconds,
      pulseBpm,
      phaseSeconds: phase,
      onsetGroupsPerPulse: selected.length / pulseCount,
    },
  };
}
