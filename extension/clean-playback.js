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
  compressor.threshold.setValueAtTime(-20, ctx.currentTime);
  compressor.knee.setValueAtTime(20, ctx.currentTime);
  compressor.ratio.setValueAtTime(4, ctx.currentTime);
  compressor.attack.setValueAtTime(0.004, ctx.currentTime);
  compressor.release.setValueAtTime(0.16, ctx.currentTime);

  const master = ctx.createGain();
  master.gain.setValueAtTime(mode === 'all' ? 0.82 : 1.02, ctx.currentTime);
  master.connect(compressor);
  compressor.connect(ctx.destination);
  return master;
}

async function playClean(mode = 'all', seconds = 90) {
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
      const musicalRole = note.musicalRole || 'unknown';
      const maxDryDuration = musicalRole === 'lead' ? 0.72 : musicalRole === 'double-stop' ? 0.46 : 0.34;
      legatoDuration = Math.max(0.12, Math.min(maxDryDuration, detectedDuration));
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
      ? 0.14 + confidence * 0.10
      : 0.22 + confidence * 0.14;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    gain.gain.setValueAtTime(Math.max(mode === 'all' ? 0.040 : 0.090, peak * 0.78), when + Math.min(0.09, legatoDuration * 0.35));
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

async function showLocalGapSummary(seconds = 90) {
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
  cleanButton.textContent = '▶ Clean notes · 00:00–01:30';
  cleanButton.addEventListener('click', () => void playClean('all', 90));

  const leadButton = document.createElement('button');
  leadButton.id = 'playLeadTen';
  leadButton.textContent = '▶ Lead line · 00:00–01:30';
  leadButton.addEventListener('click', () => void playClean('lead', 90));

  const bridgedButton = document.createElement('button');
  bridgedButton.id = 'playBridgedLeadTen';
  bridgedButton.textContent = '▶ Bridged lead · 00:00–01:30';
  bridgedButton.title = 'Diagnostic only: holds lead notes through missing spans up to 2.2 seconds.';
  bridgedButton.addEventListener('click', () => void playClean('bridged', 90));

  const stopButton = document.createElement('button');
  stopButton.id = 'stopCleanPlayback';
  stopButton.textContent = '■ Stop clean';
  stopButton.addEventListener('click', stopCleanPlayback);

  actions.append(cleanButton, leadButton, bridgedButton, stopButton);

  const status = document.createElement('span');
  status.id = 'cleanPlaybackStatus';
  status.textContent = 'Reading local transcription gap diagnostics…';
  statusRow.append(status);
  void showLocalGapSummary(90);
});


// v0.5.6 musical renderers. These do not alter transcription; they only render
// the same saved notes in a more musical way for listening and evaluation.
const MUSICAL_PLAYBACK_SECONDS = 90;
const MUSICAL_RENDERER_VERSION = 'rhythm-guitar-render-v1';
const VIOLIN_RENDERER_VERSION = 'violin-legato-render-v1';

function musicalOutputChain(ctx, gainValue = 1.0) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-20, ctx.currentTime);
  compressor.knee.setValueAtTime(22, ctx.currentTime);
  compressor.ratio.setValueAtTime(4.5, ctx.currentTime);
  compressor.attack.setValueAtTime(0.004, ctx.currentTime);
  compressor.release.setValueAtTime(0.20, ctx.currentTime);

  const master = ctx.createGain();
  master.gain.setValueAtTime(gainValue, ctx.currentTime);
  master.connect(compressor);
  compressor.connect(ctx.destination);
  return master;
}

function rhythmStrokeClusters(notes) {
  const clusters = clusterNotes(notes, 0.04);
  return clusters.map(cluster => ({
    anchor: cluster.anchor,
    notes: [...cluster.notes]
      .sort((a, b) => Number(a.guitar?.string || 9) - Number(b.guitar?.string || 9) || Number(a.midi) - Number(b.midi))
      .slice(0, 6),
  }));
}

async function playRhythmGuitar(seconds = MUSICAL_PLAYBACK_SECONDS) {
  stopCleanPlayback();
  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  await ctx.resume();

  const result = await cleanLoadResult();
  if (!result?.notes?.length) {
    setCleanStatus('No saved notes found for rhythm-guitar playback.');
    stopCleanPlayback();
    return;
  }

  const valid = result.notes.filter(note =>
    Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds
  );
  const strokes = rhythmStrokeClusters(valid);
  if (!strokes.length) {
    setCleanStatus('No tempo-aligned strokes found.');
    stopCleanPlayback();
    return;
  }

  const master = musicalOutputChain(ctx, 1.08);
  const startAt = ctx.currentTime + 0.08;
  let direction = 1;

  for (let s = 0; s < strokes.length; s += 1) {
    const stroke = strokes[s];
    const nextStroke = strokes[s + 1];
    const strokeWindow = Math.max(0.16, Math.min(0.72, (nextStroke?.anchor ?? seconds) - stroke.anchor));
    const notes = direction > 0 ? stroke.notes : [...stroke.notes].reverse();
    direction *= -1;

    for (let i = 0; i < notes.length; i += 1) {
      const note = notes[i];
      const when = startAt + stroke.anchor + i * 0.011;
      const confidence = Math.max(0, Math.min(1, Number(note.confidence || 0.5)));
      const frequency = cleanMidiToFrequency(note.midi);
      const musicalRole = note.musicalRole || 'unknown';
      const roleMax = musicalRole === 'lead' ? 0.58 : musicalRole === 'double-stop' ? 0.44 : 0.34;
      const duration = Math.max(0.12, Math.min(roleMax, strokeWindow * 0.72));

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(frequency, when);

      const body = ctx.createBiquadFilter();
      body.type = 'lowpass';
      body.frequency.setValueAtTime(Math.max(1400, Math.min(3900, frequency * 7.5)), when);
      body.Q.setValueAtTime(0.7, when);

      const gain = ctx.createGain();
      const peak = 0.085 + confidence * 0.075;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.006);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.012, peak * 0.24), when + Math.min(0.085, duration * 0.34));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

      osc.connect(body);
      body.connect(gain);
      gain.connect(master);
      osc.start(when);
      osc.stop(when + duration + 0.02);
      cleanSources.push(osc);
    }
  }

  setCleanStatus(
    'Playing rhythm guitar: ' + strokes.length + ' tempo-aligned strokes · alternating strum · 00:00–01:30.'
  );
  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 2.5) * 1000);
}

async function playViolinLegato(seconds = MUSICAL_PLAYBACK_SECONDS) {
  stopCleanPlayback();
  cleanAudioContext = new AudioContext();
  const ctx = cleanAudioContext;
  await ctx.resume();

  const result = await cleanLoadResult();
  if (!result?.notes?.length) {
    setCleanStatus('No saved notes found for violin playback.');
    stopCleanPlayback();
    return;
  }

  const roleLeadNotes = result.notes.filter(note => note.musicalRole === 'lead' || note.musicalRole === 'double-stop');
  const lead = extractLeadLine(roleLeadNotes.length ? roleLeadNotes : result.notes)
    .filter(note => Number.isFinite(Number(note.start)) && Number.isFinite(Number(note.midi)) && Number(note.start) < seconds);
  if (!lead.length) {
    setCleanStatus('No lead line found for violin playback.');
    stopCleanPlayback();
    return;
  }

  const master = musicalOutputChain(ctx, 1.04);
  const startAt = ctx.currentTime + 0.08;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2300, startAt);
  filter.Q.setValueAtTime(1.05, startAt);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);

  const vibrato = ctx.createOscillator();
  vibrato.frequency.setValueAtTime(5.2, startAt);
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.setValueAtTime(13, startAt); // cents
  vibrato.connect(vibratoDepth);
  vibratoDepth.connect(osc.detune);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(master);

  let previousFrequency = cleanMidiToFrequency(lead[0].midi);
  osc.frequency.setValueAtTime(previousFrequency, startAt);

  for (let i = 0; i < lead.length; i += 1) {
    const note = lead[i];
    const noteStart = startAt + Number(note.start);
    const nextStartSeconds = i + 1 < lead.length ? Number(lead[i + 1].start) : seconds;
    const gapToNext = Math.max(0, nextStartSeconds - Number(note.start));
    const frequency = cleanMidiToFrequency(note.midi);
    const confidence = Math.max(0, Math.min(1, Number(note.confidence || 0.5)));
    const level = 0.11 + confidence * 0.075;

    if (i === 0 || gapToNext > 1.1) {
      osc.frequency.setValueAtTime(frequency, noteStart);
    } else {
      osc.frequency.setValueAtTime(previousFrequency, Math.max(startAt, noteStart - 0.035));
      osc.frequency.exponentialRampToValueAtTime(frequency, noteStart + 0.035);
    }
    previousFrequency = frequency;

    gain.gain.cancelScheduledValues(noteStart);
    const current = Math.max(0.0001, gain.gain.value || 0.0001);
    gain.gain.setValueAtTime(current, noteStart);
    gain.gain.linearRampToValueAtTime(level, noteStart + 0.045);

    const sustainUntil = Math.max(
      noteStart + 0.18,
      startAt + Math.min(nextStartSeconds - 0.025, Number(note.start) + 1.6),
    );
    gain.gain.setValueAtTime(Math.max(0.045, level * 0.82), sustainUntil);

    if (gapToNext > 0.85 || i === lead.length - 1) {
      const fadeEnd = Math.min(startAt + seconds, sustainUntil + 0.20);
      gain.gain.exponentialRampToValueAtTime(0.0001, fadeEnd);
    }
  }

  osc.start(startAt);
  vibrato.start(startAt);
  const stopAt = startAt + seconds + 0.25;
  osc.stop(stopAt);
  vibrato.stop(stopAt);
  cleanSources.push(osc, vibrato);

  setCleanStatus(
    'Playing violin-style legato: ' + lead.length + ' lead notes · sustained phrasing + vibrato · 00:00–01:30.'
  );
  window.setTimeout(() => {
    if (cleanAudioContext === ctx) stopCleanPlayback();
  }, (seconds + 2.5) * 1000);
}

window.addEventListener('DOMContentLoaded', () => {
  const actions = document.querySelector('.playbackCard .playbackActions');
  if (!actions) return;

  const rhythmButton = document.createElement('button');
  rhythmButton.id = 'playRhythmGuitar';
  rhythmButton.textContent = '▶ Rhythm guitar · 00:00–01:30';
  rhythmButton.title = 'Same transcription rendered as tempo-aligned alternating guitar strums.';
  rhythmButton.addEventListener('click', () => void playRhythmGuitar(90));

  const violinButton = document.createElement('button');
  violinButton.id = 'playViolinLegato';
  violinButton.textContent = '▶ Violin legato · 00:00–01:30';
  violinButton.title = 'Same transcription lead line rendered with sustained notes, portamento and vibrato.';
  violinButton.addEventListener('click', () => void playViolinLegato(90));

  actions.append(rhythmButton, violinButton);
});
