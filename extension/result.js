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
let playbackDuration = 0;
let playbackNotes = [];
let nextNoteIndex = 0;
let activeSources = new Set();

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

function scheduleSynthNote(note, when, windowEndSeconds) {
  if (!audioContext || !masterGain) return;

  const frequency = midiToFrequency(note.midi);
  const remaining = Math.max(0.05, windowEndSeconds - note.start);
  const sourceDuration = Math.max(0.08, Math.min(note.end - note.start, remaining, 2.4));
  const audibleDuration = Math.max(0.12, Math.min(sourceDuration, 1.8));
  const confidence = Math.max(0, Math.min(1, note.confidence ?? 0.5));

  const oscillator = audioContext.createOscillator();
  oscillator.type = result?.instrument === 'guitar' ? 'triangle' : 'sine';
  oscillator.frequency.setValueAtTime(frequency, when);

  const filter = audioContext.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(result?.instrument === 'guitar' ? 2400 : 4200, when);
  filter.Q.setValueAtTime(0.7, when);

  const gain = audioContext.createGain();
  const peak = 0.028 + confidence * 0.035;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.008, peak * 0.35), when + Math.min(0.18, audibleDuration * 0.45));
  gain.gain.exponentialRampToValueAtTime(0.0001, when + audibleDuration);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  activeSources.add(oscillator);
  oscillator.addEventListener('ended', () => activeSources.delete(oscillator), { once: true });
  oscillator.start(when);
  oscillator.stop(when + audibleDuration + 0.02);
}

function updatePlaybackUi() {
  if (!audioContext || !playbackDuration) return;
  const elapsed = Math.max(0, audioContext.currentTime - playbackStartedAt);
  const clamped = Math.min(elapsed, playbackDuration);
  const pct = playbackDuration > 0 ? (clamped / playbackDuration) * 100 : 0;
  document.querySelector('#playbackClock').textContent = `${clamped.toFixed(1)}s / ${playbackDuration.toFixed(1)}s`;
  document.querySelector('#playbackProgress').style.width = `${pct}%`;

  const rows = document.querySelectorAll('#notesBody tr.playing');
  rows.forEach(row => row.classList.remove('playing'));
  const nearby = [...document.querySelectorAll('#notesBody tr[data-start]')]
    .find(row => Math.abs(Number(row.dataset.start) - clamped) < 0.08);
  nearby?.classList.add('playing');

  if (elapsed >= playbackDuration + 0.05) stopPlayback(true);
}

function scheduleAhead() {
  if (!audioContext) return;
  const elapsed = Math.max(0, audioContext.currentTime - playbackStartedAt);
  const horizon = elapsed + LOOKAHEAD_SECONDS;

  while (nextNoteIndex < playbackNotes.length && playbackNotes[nextNoteIndex].start <= horizon) {
    const note = playbackNotes[nextNoteIndex++];
    const when = playbackStartedAt + note.start;
    if (when >= audioContext.currentTime - 0.03) scheduleSynthNote(note, Math.max(when, audioContext.currentTime), playbackDuration);
  }
}

async function startPlayback(seconds = null) {
  if (!result?.notes?.length) return;
  await stopPlayback(false);

  playbackDuration = Math.max(0.1, Math.min(seconds ?? result.duration_seconds, result.duration_seconds));
  playbackNotes = result.notes
    .filter(note => Number.isFinite(note.start) && Number.isFinite(note.midi) && note.start < playbackDuration)
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  if (!playbackNotes.length) {
    document.querySelector('#playbackStatus').textContent = 'No notes found in this playback window.';
    return;
  }

  audioContext = new AudioContext();
  await audioContext.resume();
  masterGain = audioContext.createGain();
  masterGain.gain.setValueAtTime(0.82, audioContext.currentTime);
  masterGain.connect(audioContext.destination);

  nextNoteIndex = 0;
  playbackStartedAt = audioContext.currentTime + 0.08;
  document.querySelector('#playbackStatus').textContent = seconds ? 'Playing first 10 seconds of detected notes…' : 'Playing full detected transcription…';
  document.querySelector('#playTen').disabled = true;
  document.querySelector('#playAll').disabled = true;
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
  playbackNotes = [];
  nextNoteIndex = 0;

  const playTen = document.querySelector('#playTen');
  const playAll = document.querySelector('#playAll');
  const stop = document.querySelector('#stopPlayback');
  if (playTen) playTen.disabled = false;
  if (playAll) playAll.disabled = false;
  if (stop) stop.disabled = true;

  document.querySelectorAll('#notesBody tr.playing').forEach(row => row.classList.remove('playing'));
  if (completed) {
    document.querySelector('#playbackStatus').textContent = 'Playback finished. Compare it with the original sample.';
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

  document.querySelector('#playTen').addEventListener('click', () => startPlayback(10));
  document.querySelector('#playAll').addEventListener('click', () => startPlayback());
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
