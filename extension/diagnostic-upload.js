function compactGuitarEarForDiagnostic(summary) {
  const guitarEar = summary?.guitarEar || {};
  const gate = summary?.guitarEarGate || {};
  if (!Object.keys(guitarEar).length && !Object.keys(gate).length) return null;
  return {
    available: guitarEar.available ?? null,
    device: guitarEar.device ?? null,
    model: guitarEar.model ?? null,
    mean_presence: guitarEar.meanPresence ?? null,
    active_fraction: guitarEar.activeFraction ?? null,
    attack_count: guitarEar.attackCount ?? null,
    active_intervals: guitarEar.activeIntervals || [],
    gate
  };
}

function diagnosticRowFromResult(result) {
  const benchmark = result.benchmark || {};
  const summary = result.summary || {};
  const raw = summary.rawByPass || {};
  const duration = Number(result.duration_seconds || 0);
  const playable = Number(summary.playableNotes ?? result.notes?.length ?? 0);
  const startSeconds = Number.isFinite(Number(benchmark.startSeconds)) ? Number(benchmark.startSeconds) : null;
  const endSeconds = Number.isFinite(Number(benchmark.endSeconds)) ? Number(benchmark.endSeconds) : null;
  const requestedDurationSeconds = Number.isFinite(Number(benchmark.requestedDurationSeconds)) ? Number(benchmark.requestedDurationSeconds) : null;
  const startLabel = startSeconds ?? 0;
  const endLabel = endSeconds ?? duration;

  return {
    user_id: null,
    youtube_video_id: benchmark.videoId || null,
    youtube_url: benchmark.videoUrl || null,
    reference_label: `${benchmark.videoId || 'local'}:${startLabel.toFixed(1)}-${endLabel.toFixed(1)}`,
    engine: result.engine || 'unknown',
    instrument: result.instrument || 'guitar',
    track_title: result.title || 'Captured audio',
    source: 'chrome-extension',
    duration_seconds: duration,
    raw_strict: raw.strict ?? null,
    raw_balanced: raw.balanced ?? null,
    raw_sensitive: raw.sensitive ?? null,
    merged_candidates: summary.mergedCandidates ?? null,
    teaching_candidates: summary.teachingCandidates ?? null,
    rejected_as_noise: summary.rejectedAsNoise ?? null,
    sensitive_only: summary.sensitiveOnly ?? null,
    playable_notes: playable,
    onset_groups: summary.onsetGroups ?? null,
    high_confidence: summary.highConfidence ?? null,
    uncertain: summary.uncertain ?? null,
    average_confidence: summary.averageConfidence ?? null,
    playable_notes_per_second: duration > 0 ? playable / duration : 0,
    source_histogram: {},
    confidence_buckets: {},
    browser_user_agent: navigator.userAgent,
    extra: {
      sampling_mode: benchmark.videoId && startSeconds === 30 && endSeconds === 60 ? 'fixed-30s-v1' : 'manual-or-other',
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      requested_duration_seconds: requestedDurationSeconds,
      guitar_ear: compactGuitarEarForDiagnostic(summary),
      backend_supabase_status: result.diagnostic?.supabase_status ?? null,
      extension_fallback_upload: true,
      audio_uploaded: false
    }
  };
}

async function uploadLatestDiagnostic() {
  try {
    const result = await loadCriticResult();
    if (!result?.benchmark?.videoId) return;

    const backendStatus = Number(result.diagnostic?.supabase_status);
    if (Number.isFinite(backendStatus) && backendStatus >= 200 && backendStatus < 300) return;

    const fingerprint = [
      result.benchmark.videoId,
      result.benchmark.startSeconds,
      result.benchmark.endSeconds,
      result.engine,
      result.summary?.playableNotes ?? result.notes?.length ?? 0
    ].join(':');
    const storageKey = `ymn-diagnostic-uploaded:${fingerprint}`;
    if (sessionStorage.getItem(storageKey) === '1') return;

    const response = await fetch(`${CRITIC_SUPABASE_URL}/rest/v1/transcription_diagnostics`, {
      method: 'POST',
      headers: {
        apikey: CRITIC_PUBLISHABLE_KEY,
        Authorization: `Bearer ${CRITIC_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(diagnosticRowFromResult(result))
    });

    if (!response.ok) {
      console.warn('Diagnostic upload failed', response.status, await response.text());
      return;
    }
    sessionStorage.setItem(storageKey, '1');
    console.info('Phase-2d diagnostic uploaded to Supabase.');
  } catch (error) {
    console.warn('Diagnostic upload failed', error);
  }
}

void uploadLatestDiagnostic();
