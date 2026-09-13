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

function setCleanStatus(message) {
  const status = document.querySelector('#cleanPlaybackStatus');
  if (status) status.textContent = message;
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
  setCleanStatus('Clean diagnostic playback stopped.');
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

function gapStats(notes, seconds) {
  const sorted = [...notes]
    .filter(note => Number(note.start) < seconds)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (!sorted.length) return { noteCount: 0, longestOnsetGap: seconds, gapsOver075: 0, gapsOver15: 0 };

  let longestOnsetGap = Math.max(0, Number(sorted[0].start));
  let gapsOver075 = longestOnsetGap > 0.75 ? 1 : 0;
  let gapsOver15 = longestOnsetGap > 1.5 ? 1 : 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.max(0, Number(sorted[i].start) - Number(sorted[i - 1].start));
    longestOnsetGap = Math.max(longestOnsetGap, gap);
    if (gap > 0.75) gapsOver075 += 1;
    if (gap > 1.5) gapsOver15 += 1;
  }
  const tailGap = Math.max(0, seconds - Number(sorted[sorted.length - 1].start));
  longestOnsetGap = Math.max(longestOnsetGap, tailGap);
  if (tailGap > 0.75) gapsOver075 += 1;
  if (tailGap > 1.5) gapsOver15 += 1;

  return { noteCount: sorted.length, longestOnsetGap, gapsOver075, gapsOver15 };
}

function activeCoverageSeconds(result, seconds) {
  const intervals = result?.summary?.guitarEar?.activeIntervals || [];
  let covered = 0;
  for (const interval of intervals) {
    const start = Math.max(0, Math.min(seconds, Number(interval.start || 0)));
    const end = Math.max(0, Math.min(seconds, Number(interval.end || 0)));
    if (end > start) covered += end - start;
  }
  return Math.min(seconds, covered);
}

function createOutputChain(ctx, mode) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-18, ctx.currentTime);
  compressor.knee.setValueAtTime(18, ctx.currentTime);
  compressor.ratio.setValueAtTime(4, ctx.currentTime);
  compressor.attack.setValueAtTime(0.004, ctx.currentTime);
  compressor.release.setValueAtTime(0.16, ctx.currentTime);

  const master = ctx.createGain();
  master.gain.setValueAtTime(mode === 'all' ? 0.52 : 0.88, ctx.currentTime);
  master.connect(compressor);
  compressor.connect(ctx.destination);
  return master;
}

async function playClean(mode = 'all', seconds = 10) {
  stopCleanPlayback();

  // Unlock audio immediately from the user gesture before any async IndexedDB work.
  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  try {
    await ctx.resume();
  } catch (error) {
    setCleanStatus(`Could not start clean audio: ${error?.message || error}`);
    return;
  }

  setCleanStatus('Loading saved transcription…');
  const result = await cleanLoadResult();
  if (!result?.notes?.length) {
    setCleanStatus('No saved detected notes were found.');
    stopCleanPlayback();
    return;
  }

  let notes = result.notes.filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)));
  if (mode === 'lead' || mode === 'bridged') notes = extractLeadLine(notes);
  notes = notes.filter(note => Number(note.start) < seconds);
  if (!notes.length) {
    setCleanStatus(`No ${mode === 'all' ? 'detected' : 'lead-line'} notes in the first ${seconds} seconds.`);
    stopCleanPlayback();
    return;
  }

  const master = createOutputChain(ctx, mode);
  const startAt = ctx.currentTime + 0.08;

  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    const when = startAt + Number(note.start);
    const nextStart = i + 1 < notes.length ? Number(notes[i + 1].start) : seconds;
    const detectedDuration = Math.max(0.04, Number(note.end || 0) - Number(note.start || 0));

    let legatoDuration;
    if (mode === 'bridged') {
      // Diagnostic only: bridge missing spans up to 2.2 s, but leave longer holes audible.
      legatoDuration = Math.max(0.28, Math.min(2.2, Math.max(detectedDuration, nextStart - Number(note.start) - 0.02)));
    } else if (mode === 'lead') {
      legatoDuration = Math.max(0.24, Math.min(1.4, Math.max(detectedDuration, nextStart - Number(note.start) - 0.025)));
    } else {
      legatoDuration = Math.max(0.18, Math.min(1.1, detectedDuration));
    }

    const osc = ctx.createOscillator();
    osc.type = mode === 'all' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(cleanMidiToFrequency(note.midi), when);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(mode === 'all' ? 3200 : 2700, when);

    const gain = ctx.createGain();
    const confidence = Math.max(0, Math.min(1, Number(note.confidence || 0.5)));
    const peak = mode === 'all'
      ? 0.09 + confidence * 0.07
      : 0.17 + confidence * 0.11;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    gain.gain.setValueAtTime(Math.max(mode === 'all' ? 0.026 : 0.07, peak * 0.76), when + Math.min(0.09, legatoDuration * 0.35));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + legatoDuration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + legatoDuration + 0.02);
    cleanSources.push(osc);
  }

  const stats = gapStats(notes, seconds);
  const coverage = activeCoverageSeconds(result, seconds);
  const modeLabel = mode === 'bridged' ? 'bridged lead' : mode === 'lead' ? 'lead line' : 'clean detected notes';
  setCleanStatus(
    `Playing ${modeLabel}: ${notes.length} notes · longest onset gap ${stats.longestOnsetGap.toFixed(2)}s · ` +
    `${stats.gapsOver075} gaps >0.75s · Guitar Ear active ${coverage.toFixed(1)}/${seconds}s.`
  );

  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 2.5) * 1000);
}

async function showLocalGapSummary(seconds = 10) {
  try {
    const result = await cleanLoadResult();
    if (!result?.notes?.length) return;
    const valid = result.notes.filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)));
    const lead = extractLeadLine(valid).filter(note => Number(note.start) < seconds);
    const stats = gapStats(lead, seconds);
    const coverage = activeCoverageSeconds(result, seconds);
    setCleanStatus(
      `Local gap check: ${stats.noteCount} lead notes / first ${seconds}s · longest onset gap ${stats.longestOnsetGap.toFixed(2)}s · ` +
      `${stats.gapsOver075} gaps >0.75s (${stats.gapsOver15} >1.5s) · Guitar Ear active ${coverage.toFixed(1)}/${seconds}s.`
    );
  } catch (error) {
    setCleanStatus(`Could not read local gap diagnostics: ${error?.message || error}`);
  }
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

  const bridgedButton = document.createElement('button');
  bridgedButton.id = 'playBridgedLeadTen';
  bridgedButton.textContent = '▶ Bridged lead · first 10 sec';
  bridgedButton.title = 'Diagnostic only: holds lead notes through missing spans up to 2.2 seconds.';
  bridgedButton.addEventListener('click', () => void playClean('bridged', 10));

  const stopButton = document.createElement('button');
  stopButton.id = 'stopCleanPlayback';
  stopButton.textContent = '■ Stop clean';
  stopButton.addEventListener('click', stopCleanPlayback);

  actions.append(cleanButton, leadButton, bridgedButton, stopButton);

  const status = document.createElement('span');
  status.id = 'cleanPlaybackStatus';
  status.textContent = 'Reading local transcription gap diagnostics…';
  statusRow.append(status);
  void showLocalGapSummary(10);
});
