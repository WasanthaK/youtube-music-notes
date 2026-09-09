const NS = 'http://www.w3.org/2000/svg';
const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';
const LOOKAHEAD_SECONDS = 0.6;
const SCHEDULER_INTERVAL_MS = 100;

let result;
let audioContext = null;
let masterGain = null;
let schedulerTimer = null;
let uiTimer = null;
let playbackStartedAt = 0;
let playbackSourceDuration = 0;
let playbackRate = 1;
let playbackNotes = [];
let nextNoteIndex = 0;
let activeSources = new Set();
let guitarWave = null;
let pluckNoiseBuffer = null;

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

async function loadLatestResult() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get('latest');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k,v]) => node.setAttribute(k, v));
  return node;
}

function downloadData(name, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

function b64ToBlobUrl(b64, type) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function renderGuitar(notes) {
  const width = Math.max(1000, 120 + notes.length * 58);
  const height = 270;
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  const top = 55, gap = 28;
  const labels = ['e', 'B', 'G', 'D', 'A', 'E'];
  for (let i=0; i<6; i++) {
    const y = top + i*gap;
    svg.append(el('line', { x1: 55, y1: y, x2: width-30, y2: y, stroke: '#666', 'stroke-width': 1 }));
    const t = el('text', { x: 28, y: y+4, class: 'noteLabel' }); t.textContent = labels[i]; svg.append(t);
  }
  notes.forEach((n, idx) => {
    if (!n.guitar) return;
    const x = 85 + idx*58;
    const lineIndex = 6 - n.guitar.string;
    const y = top + lineIndex*gap;
    svg.append(el('circle', { cx: x, cy: y, r: 12, fill: '#fff', stroke: '#111' }));
    const f = el('text', { x: x-4, y: y+4, 'font-size': 11, 'font-weight': 700 }); f.textContent = n.guitar.fret; svg.append(f);
    const label = el('text', { x: x-13, y: 25, class: 'noteLabel' }); label.textContent = n.name; svg.append(label);
    const tm = el('text', { x: x-13, y: 245, class: 'noteLabel' }); tm.textContent = n.start.toFixed(1)+'s'; svg.append(tm);
  });
  return svg;
}

function renderFlute(notes) {
  const width = Math.max(1000, 120 + notes.length * 54);
  const height = 270;
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  const top = 80, gap = 18;
  for (let i=0; i<5; i++) svg.append(el('line', { x1: 55, y1: top+i*gap, x2: width-30, y2: top+i*gap, stroke: '#555' }));

  const stepMap = {0:0, 2:1, 4:2, 5:3, 7:4, 9:5, 11:6};
  function staffStep(midi) {
    const octave = Math.floor(midi/12)-1;
    const pc = midi % 12;
    const nearest = Object.keys(stepMap).map(Number).sort((a,b)=>Math.abs(a-pc)-Math.abs(b-pc))[0];
    const diatonic = octave*7 + stepMap[nearest];
    return diatonic - (4*7 + 2);
  }

  notes.forEach((n, idx) => {
    const x = 85 + idx*54;
    const y = top + 4*gap - staffStep(n.midi)*(gap/2);
    svg.append(el('ellipse', { cx: x, cy: y, rx: 7, ry: 5, fill: '#111', transform: `rotate(-18 ${x} ${y})` }));
    svg.append(el('line', { x1: x+6, y1: y, x2: x+6, y2: y-34, stroke: '#111', 'stroke-width': 1.5 }));
    const label = el('text', { x: x-13, y: 32, class: 'noteLabel' }); label.textContent = n.name; svg.append(label);
    const tm = el('text', { x: x-12, y: 235, class: 'noteLabel' }); tm.textContent = n.start.toFixed(1)+'s'; svg.append(tm);
  });
  return svg;
}

function renderTable(notes, instrument) {
  const body = document.querySelector('#notesBody');
  body.innerHTML = '';
  document.querySelector('#extraHead').textContent = instrument === 'guitar' ? 'String / fret' : 'MIDI';
  notes.forEach(n => {
    const tr = document.createElement('tr');
    const pos = instrument === 'guitar' && n.guitar ? `String ${n.guitar.string}, fret ${n.guitar.fret}` : n.midi;
    tr.dataset.start = n.start;
    tr.innerHTML = `<td>${n.start.toFixed(2)}s</td><td>${n.name}</td><td>${(n.end-n.start).toFixed(2)}s</td><td>${Math.round(n.confidence*100)}%</td><td>${pos}</td>`;
    body.append(tr);
  });
}

function buildGuitarWave(ctx) {
  const real = new Float32Array(10);
  const imag = new Float32Array(10);
  imag[1] = 1.00;
  imag[2] = 0.58;
  imag[3] = 0.34;
  imag[4] = 0.23;
  imag[5] = 0.15;
  imag[6] = 0.10;
  imag[7] = 0.065;
  imag[8] = 0.04;
  imag[9] = 0.025;
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

function buildPluckNoise(ctx) {
  const length = Math.max(64, Math.floor(ctx.sampleRate * 0.035));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const decay = Math.pow(1 - i / length, 2.2);
    data[i] = (Math.random() * 2 - 1) * decay;
  }
  return buffer;
}

function registerSource(source) {
  activeSources.add(source);
  source.addEventListener('ended', () => activeSources.delete(source), { once: true });
}

function scheduleGuitarNote(note, when, sourceWindowEndSeconds) {
  if (!audioContext || !masterGain) return;

  const frequency = midiToFrequency(note.midi);
  const sourceRemaining = Math.max(0.04, sourceWindowEndSeconds - note.start);
  const sourceDuration = Math.max(0.05, Math.min(note.end - note.start, sourceRemaining, 2.6));
  const wallDuration = sourceDuration / playbackRate;
  const releaseTail = Math.min(0.24 / playbackRate, 0.34);
  const audibleDuration = Math.max(0.16, Math.min(wallDuration + releaseTail, 2.9));
  const confidence = Math.max(0, Math.min(1, note.confidence ?? 0.5));
  const stringNumber = Number(note.guitar?.string || 3.5);
  const stringBrightness = 0.78 + (6 - stringNumber) * 0.065;

  const oscillator = audioContext.createOscillator();
  oscillator.setPeriodicWave(guitarWave || buildGuitarWave(audioContext));
  oscillator.frequency.setValueAtTime(frequency, when);

  const filter = audioContext.createBiquadFilter();
  filter.type = 'lowpass';
  const cutoff = Math.max(1300, Math.min(5200, frequency * 8.5 * stringBrightness));
  filter.frequency.setValueAtTime(cutoff, when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(850, cutoff * 0.58), when + Math.min(0.28, audibleDuration * 0.55));
  filter.Q.setValueAtTime(0.72, when);

  const body = audioContext.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.setValueAtTime(190 + (6 - stringNumber) * 18, when);
  body.Q.setValueAtTime(1.1, when);
  body.gain.setValueAtTime(2.4, when);

  const gain = audioContext.createGain();
  const peak = 0.018 + confidence * 0.026;
  const sustain = Math.max(0.0035, peak * 0.22);
  const releaseStart = Math.max(when + 0.055, when + Math.min(wallDuration, audibleDuration - 0.08));
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.004);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.006, peak * 0.42), when + Math.min(0.075, audibleDuration * 0.35));
  gain.gain.exponentialRampToValueAtTime(sustain, releaseStart);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + audibleDuration);

  const panner = audioContext.createStereoPanner();
  panner.pan.setValueAtTime(Math.max(-0.22, Math.min(0.22, (3.5 - stringNumber) * 0.075)), when);

  oscillator.connect(filter);
  filter.connect(body);
  body.connect(gain);
  gain.connect(panner);
  panner.connect(masterGain);

  oscillator.start(when);
  oscillator.stop(when + audibleDuration + 0.02);
  registerSource(oscillator);

  if (pluckNoiseBuffer) {
    const noise = audioContext.createBufferSource();
    noise.buffer = pluckNoiseBuffer;
    const noiseFilter = audioContext.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(Math.max(900, Math.min(5200, frequency * 7)), when);
    noiseFilter.Q.setValueAtTime(0.9, when);
    const noiseGain = audioContext.createGain();
    const noisePeak = 0.006 + confidence * 0.009;
    noiseGain.gain.setValueAtTime(noisePeak, when);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03 / playbackRate);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(panner);
    noise.start(when);
    noise.stop(when + 0.04 / playbackRate);
    registerSource(noise);
  }
}

function scheduleFluteNote(note, when, sourceWindowEndSeconds) {
  if (!audioContext || !masterGain) return;
  const frequency = midiToFrequency(note.midi);
  const sourceRemaining = Math.max(0.05, sourceWindowEndSeconds - note.start);
  const sourceDuration = Math.max(0.08, Math.min(note.end - note.start, sourceRemaining, 2.4));
  const audibleDuration = Math.max(0.12, Math.min(sourceDuration / playbackRate, 2.6));
  const confidence = Math.max(0, Math.min(1, note.confidence ?? 0.5));

  const oscillator = audioContext.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, when);
  const gain = audioContext.createGain();
  const peak = 0.025 + confidence * 0.03;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.012);
  gain.gain.setValueAtTime(Math.max(0.008, peak * 0.6), when + Math.min(0.08, audibleDuration * 0.4));
  gain.gain.exponentialRampToValueAtTime(0.0001, when + audibleDuration);
  oscillator.connect(gain);
  gain.connect(masterGain);
  oscillator.start(when);
  oscillator.stop(when + audibleDuration + 0.02);
  registerSource(oscillator);
}

function scheduleSynthNote(note, when, sourceWindowEndSeconds) {
  if (result?.instrument === 'guitar') scheduleGuitarNote(note, when, sourceWindowEndSeconds);
  else scheduleFluteNote(note, when, sourceWindowEndSeconds);
}

function updatePlaybackUi() {
  if (!audioContext || !playbackSourceDuration) return;
  const wallElapsed = Math.max(0, audioContext.currentTime - playbackStartedAt);
  const sourceElapsed = Math.min(playbackSourceDuration, wallElapsed * playbackRate);
  const pct = playbackSourceDuration > 0 ? (sourceElapsed / playbackSourceDuration) * 100 : 0;
  const rateLabel = playbackRate === 1 ? '' : ` · ${playbackRate.toFixed(2)}×`;
  document.querySelector('#playbackClock').textContent = `${sourceElapsed.toFixed(1)}s / ${playbackSourceDuration.toFixed(1)}s${rateLabel}`;
  document.querySelector('#playbackProgress').style.width = `${pct}%`;

  document.querySelectorAll('#notesBody tr.playing').forEach(row => row.classList.remove('playing'));
  const nearby = [...document.querySelectorAll('#notesBody tr[data-start]')]
    .find(row => Math.abs(Number(row.dataset.start) - sourceElapsed) < 0.08);
  nearby?.classList.add('playing');

  if (sourceElapsed >= playbackSourceDuration - 0.001) stopPlayback(true);
}

function scheduleAhead() {
  if (!audioContext) return;
  const wallElapsed = Math.max(0, audioContext.currentTime - playbackStartedAt);
  const sourceElapsed = wallElapsed * playbackRate;
  const sourceHorizon = sourceElapsed + LOOKAHEAD_SECONDS * playbackRate;

  while (nextNoteIndex < playbackNotes.length && playbackNotes[nextNoteIndex].start <= sourceHorizon) {
    const note = playbackNotes[nextNoteIndex++];
    const when = playbackStartedAt + note.start / playbackRate;
    if (when >= audioContext.currentTime - 0.03) scheduleSynthNote(note, Math.max(when, audioContext.currentTime), playbackSourceDuration);
  }
}

async function startPlayback(seconds = null, rate = 1) {
  if (!result?.notes?.length) return;
  await stopPlayback(false);

  playbackRate = Math.max(0.5, Math.min(1.25, rate));
  playbackSourceDuration = Math.max(0.1, Math.min(seconds ?? result.duration_seconds, result.duration_seconds));
  playbackNotes = result.notes
    .filter(note => Number.isFinite(note.start) && Number.isFinite(note.midi) && note.start < playbackSourceDuration)
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  if (!playbackNotes.length) {
    document.querySelector('#playbackStatus').textContent = 'No notes found in this playback window.';
    return;
  }

  audioContext = new AudioContext();
  await audioContext.resume();
  masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(result?.instrument === 'guitar' ? 0.92 : 0.82, audioContext.currentTime);
  masterGain.connect(audioContext.destination);
  guitarWave = result?.instrument === 'guitar' ? buildGuitarWave(audioContext) : null;
  pluckNoiseBuffer = result?.instrument === 'guitar' ? buildPluckNoise(audioContext) : null;

  nextNoteIndex = 0;
  playbackStartedAt = audioContext.currentTime + 0.08;
  const windowLabel = seconds ? `first ${Math.round(playbackSourceDuration)} seconds` : 'full transcription';
  const rateLabel = playbackRate === 1 ? '' : ` at ${playbackRate.toFixed(2)}× speed`;
  document.querySelector('#playbackStatus').textContent = `Playing ${windowLabel}${rateLabel} with guitar-like plucked tones…`;
  ['playTen','playTenSlow','playAll'].forEach(id => { const b = document.querySelector(`#${id}`); if (b) b.disabled = true; });
  document.querySelector('#stopPlayback').disabled = false;
  document.querySelector('#playbackProgress').style.width = '0%';

  scheduleAhead();
  schedulerTimer = setInterval(scheduleAhead, SCHEDULER_INTERVAL_MS);
  uiTimer = setInterval(updatePlaybackUi, 100);
}

async function stopPlayback(completed = false) {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (uiTimer) clearInterval(uiTimer);
  schedulerTimer = null;
  uiTimer = null;

  activeSources.forEach(source => {
    try { source.stop(); } catch {}
  });
  activeSources.clear();

  if (audioContext) {
    try { await audioContext.close(); } catch {}
  }
  audioContext = null;
  masterGain = null;
  guitarWave = null;
  pluckNoiseBuffer = null;
  playbackNotes = [];
  nextNoteIndex = 0;

  ['playTen','playTenSlow','playAll'].forEach(id => { const b = document.querySelector(`#${id}`); if (b) b.disabled = false; });
  const stop = document.querySelector('#stopPlayback');
  if (stop) stop.disabled = true;

  document.querySelectorAll('#notesBody tr.playing').forEach(row => row.classList.remove('playing'));
  if (completed) {
    document.querySelector('#playbackStatus').textContent = 'Playback finished. Compare what you heard with the original sample.';
    document.querySelector('#playbackProgress').style.width = '100%';
  } else if (result) {
    document.querySelector('#playbackStatus').textContent = 'Ready to play.';
    document.querySelector('#playbackClock').textContent = '0.0s';
    document.querySelector('#playbackProgress').style.width = '0%';
  }
}

function originalSampleUrl() {
  if (!result?.benchmark?.videoUrl) return null;
  try {
    const url = new URL(result.benchmark.videoUrl);
    const start = Math.max(0, Math.floor(result.benchmark.startSeconds || 0));
    url.searchParams.set('t', `${start}s`);
    return url.toString();
  } catch {
    return result.benchmark.videoUrl;
  }
}

(async () => {
  try {
    result = await loadLatestResult();
  } catch (error) {
    document.querySelector('#chart').textContent = `Could not load analysis result: ${error?.message || error}`;
    return;
  }

  if (!result) {
    document.querySelector('#chart').textContent = 'No analysis result found.';
    return;
  }

  document.querySelector('#title').textContent = result.title || 'Music Note Chart';
  document.querySelector('#meta').textContent = `${result.instrument} · ${result.mode} · ${result.notes.length} notes · ${result.duration_seconds.toFixed(1)} sec capture`;
  document.querySelector('#chartTitle').textContent = result.instrument === 'guitar' ? 'Guitar TAB (MVP fingering)' : 'Flute melody staff (MVP)';
  const chart = document.querySelector('#chart');
  chart.append(result.instrument === 'guitar' ? renderGuitar(result.notes) : renderFlute(result.notes));
  renderTable(result.notes, result.instrument);

  document.querySelector('#playTen').addEventListener('click', () => startPlayback(10, 1));
  document.querySelector('#playTenSlow').addEventListener('click', () => startPlayback(10, 0.75));
  document.querySelector('#playAll').addEventListener('click', () => startPlayback(null, 1));
  document.querySelector('#stopPlayback').addEventListener('click', () => stopPlayback(false));

  const originalUrl = originalSampleUrl();
  if (originalUrl) {
    const originalButton = document.querySelector('#openOriginal');
    originalButton.hidden = false;
    originalButton.addEventListener('click', () => {
      if (chrome?.tabs?.create) chrome.tabs.create({ url: originalUrl });
      else window.open(originalUrl, '_blank', 'noopener');
    });
  }

  document.querySelector('#downloadJson').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    downloadData('music-notes.json', url);
  });

  document.querySelector('#downloadMidi').addEventListener('click', () => {
    if (!result.midi_base64) return alert('MIDI export not available.');
    downloadData('music-notes.mid', b64ToBlobUrl(result.midi_base64, 'audio/midi'));
  });
})();
