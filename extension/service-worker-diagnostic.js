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
    phase: guitarEar.phase ?? null,
    model_sha256: guitarEar.modelSha256 ?? null,
    graph_optimization_level: guitarEar.graphOptimizationLevel ?? null,
    rhythm_conditioning: guitarEar.rhythmConditioning ?? null,
    model_fallback_reason: guitarEar.modelFallbackReason ?? null,
    error: guitarEar.error ?? null,
    mean_presence: guitarEar.meanPresence ?? null,
    active_fraction: guitarEar.activeFraction ?? null,
    attack_count: guitarEar.attackCount ?? null,
    active_intervals: guitarEar.activeIntervals || [],
    inference_mode: guitarEar.inferenceMode ?? null,
    window_stride_seconds: guitarEar.windowStrideSeconds ?? null,
    active_segment_fraction: guitarEar.activeSegmentFraction ?? null,
    segment_scores: guitarEar.segmentScores || [],
    gate
  };
}

function diagnosticRowFromResult(result) {
  const s = result.summary || {};
  return {
    user_id: null,
    youtube_video_id: result.benchmark.videoId || null,
    youtube_url: result.benchmark.videoUrl || null,
    reference_label: result.benchmark.mode || 'fixed-30s-v1',
    engine: result.engine || 'unknown',
    instrument: result.instrument,
    track_title: result.title,
    source: 'chrome-extension-browser',
    duration_seconds: result.duration_seconds,
    raw_strict: s.rawByPass?.strict ?? null,
    raw_balanced: s.rawByPass?.balanced ?? null,
    raw_sensitive: s.rawByPass?.sensitive ?? null,
    merged_candidates: s.mergedCandidates ?? null,
    teaching_candidates: s.teachingCandidates ?? null,
    rejected_as_noise: s.rejectedAsNoise ?? null,
    sensitive_only: s.sensitiveOnly ?? null,
    playable_notes: s.playableNotes ?? result.notes?.length ?? null,
    onset_groups: s.onsetGroups ?? null,
    high_confidence: s.highConfidence ?? null,
    uncertain: s.uncertain ?? null,
    average_confidence: s.averageConfidence ?? null,
    playable_notes_per_second: s.playablePerSecond ?? perSecond(result.notes?.length || 0, result.duration_seconds),
    source_histogram: {},
    confidence_buckets: {},
    browser_user_agent: navigator.userAgent,
    extra: {
      benchmark_mode: result.benchmark.mode,
      start_seconds: result.benchmark.startSeconds,
      end_seconds: result.benchmark.endSeconds,
      requested_duration_seconds: result.benchmark.requestedDurationSeconds,
      local_browser_analysis: true,
      audio_uploaded: false,
      local_audio_retained: true,
      service_worker_primary_upload: true,
      run_id: result.run_id || null,
      guitar_ear: compactGuitarEar(s),
      tempo: s.tempo || null,
      rhythm: s.rhythm || null,
      musical_decoder: s.musicalDecoder || null,
      note_trace: (result.notes || []).map(note => ({
        start: Number(note.start || 0),
        end: Number(note.end || note.start || 0),
        midi: Number(note.midi),
        confidence: Number(note.confidence || 0),
        chord_id: Number.isFinite(Number(note.chordId)) ? Number(note.chordId) : null,
        support: note.guitarEarSupport || null,
        musical_role: note.musicalRole || null,
        rhythm_slot: Number.isFinite(Number(note.rhythmSlot)) ? Number(note.rhythmSlot) : null,
        rhythm_beat: Number.isFinite(Number(note.rhythmBeatIndex)) ? Number(note.rhythmBeatIndex) : null,
        rhythm_subdivision: Number.isFinite(Number(note.rhythmSubdivision)) ? Number(note.rhythmSubdivision) : null,
        rhythm_slot_time: Number.isFinite(Number(note.rhythmSlotTime)) ? Number(note.rhythmSlotTime) : null,
        string: note.guitar?.string ?? null,
        fret: note.guitar?.fret ?? null
      }))
    }
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

  const { shareDiagnostics } = await chrome.storage.local.get('shareDiagnostics');
  if (shareDiagnostics !== true) {
    const status = { supabase_status: null, supabase_ok: null, skipped: true, reason: 'disabled-by-user' };
    await persistDiagnosticStatus(status).catch(() => {});
    return status;
  }

  if (!result.run_id) result.run_id = crypto.randomUUID();
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
