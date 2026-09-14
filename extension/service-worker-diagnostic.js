const SUPABASE_URL = 'https://kgoowanohmtprbwdokjd.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4dlNhnTkkyQRx8CJTqWXfQ_tfx8bz-o';
const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const perSecond = (count, duration) => duration > 0 ? count / duration : 0;

function compactGuitarEar(summary) {
  const guitarEar = summary?.guitarEar || {};
  const gate = summary?.guitarEarGate || {};
  if (!Object.keys(guitarEar).length && !Object.keys(gate).length) return null;
  return {
    available: guitarEar.available ?? null,
    device: guitarEar.device ?? null,
    model: guitarEar.model ?? null,
    presence_frame_threshold: guitarEar.presenceFrameThreshold ?? null,
    presence_segment_threshold: guitarEar.presenceSegmentThreshold ?? null,
    attack_threshold: guitarEar.attackThreshold ?? null,
    mean_presence: guitarEar.meanPresence ?? null,
    active_fraction: guitarEar.activeFraction ?? null,
    attack_count: guitarEar.attackCount ?? null,
    active_intervals: guitarEar.activeIntervals || [],
    gate,
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

  return {
    user_id: null,
    youtube_video_id: benchmark.videoId || null,
    youtube_url: benchmark.videoUrl || null,
    reference_label: benchmark.mode || 'fixed-30s-v1',
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
    playable_notes_per_second: summary.playablePerSecond ?? perSecond(playable, duration),
    source_histogram: {},
    confidence_buckets: {},
    browser_user_agent: navigator.userAgent,
    extra: {
      benchmark_mode: benchmark.mode || null,
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      requested_duration_seconds: requestedDurationSeconds,
      local_browser_analysis: true,
      audio_uploaded: false,
      local_audio_retained: true,
      guitar_ear: compactGuitarEar(summary),
      service_worker_primary_upload: true,
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistDiagnosticStatus(status) {
  const db = await openDb();
  try {
    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get('latest');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (!existing) return;
    existing.diagnostic = status;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(existing, 'latest');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  } finally {
    db.close();
  }
}

export async function uploadDiagnosticFromResult(result) {
  if (!result?.benchmark?.videoId) {
    return { supabase_status: null, skipped: true, reason: 'no-benchmark-video-id' };
  }

  const row = diagnosticRowFromResult(result);
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/transcription_diagnostics`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      });
      lastStatus = response.status;
      if (response.ok) {
        const status = { supabase_status: response.status, supabase_ok: true, attempt };
        await persistDiagnosticStatus(status).catch(() => {});
        return status;
      }
      lastError = await response.text();
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (attempt < 3) await sleep(attempt * 400);
  }

  const status = {
    supabase_status: lastStatus,
    supabase_ok: false,
    error: lastError || 'Diagnostic upload failed.',
  };
  await persistDiagnosticStatus(status).catch(() => {});
  return status;
}
