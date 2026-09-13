const CLEAN_DB_NAME = 'youtube-music-notes-extension';
const CLEAN_STORE_NAME = 'analysis';

let cleanAudioContext = null;
let cleanSources = [];

function cleanOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLEAN_DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cleanLoadResult() {
  const db = await cleanOpenDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CLEAN_STORE_NAME, 'readonly');
      const req = tx.objectStore(CLEAN_STORE_NAME).get('latest');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function cleanMidiToFrequency(midi) {
  return 440 * Math.pow(2, (Number(midi) - 69) / 12);
}

function stopCleanPlayback() {
  for (const source of cleanSources) {
    try { source.stop(); } catch {}
  }
  cleanSources = [];
  if (cleanAudioContext) {
    const ctx = cleanAudioContext;
    cleanAudioContext = null;
    void ctx.close();
  }
  const status = document.querySelector('#cleanPlaybackStatus');
  if (status) status.textContent = 'Clean diagnostic playback stopped.';
}

function clusterNotes(notes, tolerance = 0.075) {
  const sorted = [...notes].sort((a, b) => Number(a.start) - Number(b.start) || Number(a.midi) - Number(b.midi));
  const clusters = [];
  for (const note of sorted) {
    if (!Number.isFinite(Number(note.start)) || !Number.isFinite(Number(note.midi))) continue;
    const last = clusters[clusters.length - 1];
    if (!last || Number(note.start) - last.anchor > tolerance) {
      clusters.push({ anchor: Number(note.start), notes: [note] });
    } else {
      last.notes.push(note);
      last.anchor = last.notes.reduce((sum, item) => sum + Number(item.start), 0) / last.notes.length;
    }
  }
  return clusters;
}

function extractLeadLine(notes) {
  const clusters = clusterNotes(notes);
  if (!clusters.length) return [];

  const candidates = clusters.map(cluster => [...cluster.notes]
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 5));

  const scores = candidates.map(list => new Array(list.length).fill(-Infinity));
  const prev = candidates.map(list => new Array(list.length).fill(-1));

  for (let j = 0; j < candidates[0].length; j += 1) {
    const n = candidates[0][j];
    const conf = Number(n.confidence || 0.5);
    const dur = Math.max(0.04, Number(n.end || 0) - Number(n.start || 0));
    scores[0][j] = conf * 2.2 + Math.min(dur, 0.8) * 0.18;
  }

  for (let i = 1; i < candidates.length; i += 1) {
    const gap = Math.max(0, clusters[i].anchor - clusters[i - 1].anchor);
    for (let j = 0; j < candidates[i].length; j += 1) {
      const curr = candidates[i][j];
      const conf = Number(curr.confidence || 0.5);
      const dur = Math.max(0.04, Number(curr.end || 0) - Number(curr.start || 0));
      const local = conf * 2.2 + Math.min(dur, 0.8) * 0.18;
      for (let k = 0; k < candidates[i - 1].length; k += 1) {
        const prior = candidates[i - 1][k];
        const interval = Math.abs(Number(curr.midi) - Number(prior.midi));
        const jumpPenalty = interval * 0.065 + (interval > 12 ? 0.9 : 0) + (interval > 19 ? 1.1 : 0);
        const gapRelaxation = gap > 0.7 ? Math.min(0.7, (gap - 0.7) * 0.35) : 0;
        const score = scores[i - 1][k] + local - Math.max(0, jumpPenalty - gapRelaxation);
        if (score > scores[i][j]) {
          scores[i][j] = score;
          prev[i][j] = k;
        }
      }
    }
  }

  let bestIndex = 0;
  const lastScores = scores[scores.length - 1];
  for (let j = 1; j < lastScores.length; j += 1) if (lastScores[j] > lastScores[bestIndex]) bestIndex = j;

  const path = [];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const note = candidates[i][bestIndex];
    path.push(note);
    bestIndex = prev[i][bestIndex];
    if (i > 0 && bestIndex < 0) bestIndex = 0;
  }
  return path.reverse();
}

async function playClean(mode = 'all', seconds = 10) {
  stopCleanPlayback();
  const result = await cleanLoadResult();
  if (!result?.notes?.length) return;

  let notes = result.notes.filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)));
  if (mode === 'lead') notes = extractLeadLine(notes);
  notes = notes.filter(note => Number(note.start) < seconds);
  if (!notes.length) return;

  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  const master = ctx.createGain();
  master.gain.value = mode === 'lead' ? 0.32 : 0.16;
  master.connect(ctx.destination);

  const startAt = ctx.currentTime + 0.08;
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    const when = startAt + Number(note.start);
    const nextStart = i + 1 < notes.length ? Number(notes[i + 1].start) : seconds;
    const detectedDuration = Math.max(0.04, Number(note.end || 0) - Number(note.start || 0));
    const legatoDuration = mode === 'lead'
      ? Math.max(0.22, Math.min(1.4, Math.max(detectedDuration, nextStart - Number(note.start) - 0.025)))
      : Math.max(0.16, Math.min(1.1, detectedDuration));

    const osc = ctx.createOscillator();
    osc.type = mode === 'lead' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(cleanMidiToFrequency(note.midi), when);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(mode === 'lead' ? 2400 : 3000, when);

    const gain = ctx.createGain();
    const peak = 0.045 + Math.max(0, Math.min(1, Number(note.confidence || 0.5))) * 0.035;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.015);
    gain.gain.setValueAtTime(Math.max(0.012, peak * 0.72), when + Math.min(0.08, legatoDuration * 0.35));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + legatoDuration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + legatoDuration + 0.02);
    cleanSources.push(osc);
  }

  const status = document.querySelector('#cleanPlaybackStatus');
  if (status) {
    status.textContent = mode === 'lead'
      ? `Playing continuity-constrained lead line (${notes.length} notes / first ${seconds}s).`
      : `Playing clean detected notes (${notes.length} notes / first ${seconds}s).`;
  }

  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 1.5) * 1000);
}

window.addEventListener('DOMContentLoaded', () => {
  const actions = document.querySelector('.playbackCard .playbackActions');
  const statusRow = document.querySelector('.playbackCard .playbackStatusRow');
  if (!actions || !statusRow) return;

  const cleanButton = document.createElement('button');
  cleanButton.id = 'playCleanTen';
  cleanButton.textContent = '▶ Clean notes · first 10 sec';
  cleanButton.addEventListener('click', () => void playClean('all', 10));

  const leadButton = document.createElement('button');
  leadButton.id = 'playLeadTen';
  leadButton.textContent = '▶ Lead line · first 10 sec';
  leadButton.addEventListener('click', () => void playClean('lead', 10));

  const stopButton = document.createElement('button');
  stopButton.id = 'stopCleanPlayback';
  stopButton.textContent = '■ Stop clean';
  stopButton.addEventListener('click', stopCleanPlayback);

  actions.append(cleanButton, leadButton, stopButton);

  const status = document.createElement('span');
  status.id = 'cleanPlaybackStatus';
  status.textContent = 'Clean diagnostic playback ready.';
  statusRow.append(status);
});
