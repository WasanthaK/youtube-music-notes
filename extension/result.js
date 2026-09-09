const NS = 'http://www.w3.org/2000/svg';
const DB_NAME = 'youtube-music-notes-extension';
const STORE_NAME = 'analysis';
let result;

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
    tr.innerHTML = `<td>${n.start.toFixed(2)}s</td><td>${n.name}</td><td>${(n.end-n.start).toFixed(2)}s</td><td>${Math.round(n.confidence*100)}%</td><td>${pos}</td>`;
    body.append(tr);
  });
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

  document.querySelector('#downloadJson').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    downloadData('music-notes.json', url);
  });

  document.querySelector('#downloadMidi').addEventListener('click', () => {
    if (!result.midi_base64) return alert('MIDI export not available.');
    downloadData('music-notes.mid', b64ToBlobUrl(result.midi_base64, 'audio/midi'));
  });
})();
