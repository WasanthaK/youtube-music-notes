const CRITIC_SUPABASE_URL = 'https://kgoowanohmtprbwdokjd.supabase.co';
const CRITIC_PUBLISHABLE_KEY = 'sb_publishable_4dlNhnTkkyQRx8CJTqWXfQ_tfx8bz-o';
const CRITIC_DB_NAME = 'youtube-music-notes-extension';
const CRITIC_STORE_NAME = 'analysis';

function openCriticDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CRITIC_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CRITIC_STORE_NAME)) request.result.createObjectStore(CRITIC_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadCriticResult() {
  const db = await openCriticDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CRITIC_STORE_NAME, 'readonly');
      const request = tx.objectStore(CRITIC_STORE_NAME).get('latest');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function compactNotes(notes) {
  if (!Array.isArray(notes)) return [];
  const max = 360;
  const step = notes.length > max ? Math.ceil(notes.length / max) : 1;
  return notes.filter((_, i) => i % step === 0).slice(0, max).map(n => ({
    start: Number(n.start?.toFixed?.(3) ?? n.start),
    end: Number(n.end?.toFixed?.(3) ?? n.end),
    midi: n.midi,
    confidence: Number((n.confidence ?? 0).toFixed?.(3) ?? n.confidence ?? 0),
    string: n.guitar?.string ?? null,
    fret: n.guitar?.fret ?? null
  }));
}

function score(label, value) {
  return `<div class="criticScore"><span>${label}</span><strong>${value}/100</strong></div>`;
}

function badge(label, value) {
  const cls = String(value || '').toLowerCase();
  return `<div class="criticBadgeRow"><span>${label}</span><strong class="criticBadge ${cls}">${value}</strong></div>`;
}

function renderCritic(critic, model) {
  const output = document.querySelector('#criticOutput');
  const sections = Array.isArray(critic.suspicious_sections) ? critic.suspicious_sections : [];
  output.innerHTML = `
    <div class="criticGrid">
      ${score('Guitar plausibility', critic.guitar_plausibility)}
      ${score('Chord plausibility', critic.chord_plausibility)}
      ${score('Fingering continuity', critic.fingering_continuity)}
      ${score('Rhythm plausibility', critic.rhythm_plausibility)}
    </div>
    <div class="criticGrid criticFlags">
      ${badge('Likely non-guitar contamination', critic.likely_non_guitar_contamination)}
      ${badge('Over-transcription', critic.over_transcription)}
      ${badge('Overall', critic.overall_assessment)}
      ${score('Critic confidence', critic.confidence_in_assessment)}
    </div>
    <p class="criticSummary"><strong>Primary failure mode:</strong> ${critic.primary_failure_mode.replaceAll('_', ' ')}. ${critic.summary}</p>
    ${sections.length ? `<div class="criticSections"><strong>Suspicious sections</strong>${sections.map(s => `<div class="criticSection"><span>${Number(s.start).toFixed(1)}–${Number(s.end).toFixed(1)}s</span><span class="criticBadge ${s.severity}">${s.severity}</span><span>${s.reason}</span></div>`).join('')}</div>` : ''}
    <p class="criticFootnote">Symbolic analysis only — the AI critic did not hear the original audio. Model: ${model || 'OpenAI'}.</p>
  `;
}

async function runCritic() {
  const button = document.querySelector('#runCritic');
  const status = document.querySelector('#criticStatus');
  const output = document.querySelector('#criticOutput');
  button.disabled = true;
  status.textContent = 'AI critic is examining the note/chord trace…';
  output.innerHTML = '';

  try {
    const result = await loadCriticResult();
    if (!result) throw new Error('No transcription result found.');
    if (result.instrument !== 'guitar') throw new Error('The AI critic is currently configured for guitar transcription only.');

    const response = await fetch(`${CRITIC_SUPABASE_URL}/functions/v1/transcription-critic`, {
      method: 'POST',
      headers: {
        apikey: CRITIC_PUBLISHABLE_KEY,
        Authorization: `Bearer ${CRITIC_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: 'chrome-extension-browser',
        instrument: 'guitar',
        title: result.title,
        engine: result.engine,
        duration_seconds: result.duration_seconds,
        summary: result.summary,
        notes: compactNotes(result.notes)
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `Critic request failed (${response.status})`);
    renderCritic(data.critic, data.model);
    status.textContent = 'AI diagnostic complete.';
  } catch (error) {
    status.textContent = `AI diagnostic failed: ${error?.message || error}`;
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#runCritic')?.addEventListener('click', runCritic);
