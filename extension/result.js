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

// ---------------------------------------------------------------------------
// TAB / Melody card (UX-03, docs/UX_SPEC.md §1 and §2). Layout maths live in
// tab-layout.js (window.TabLayout); this part only turns a layout into DOM.
// ---------------------------------------------------------------------------

const TAB_RESIZE_DEBOUNCE_MS = 150; // §2.10
let tabLayout = null;
let tabRenderedWidth = 0;
let tabResizeTimer = null;
let tabEventNodes = []; // event index -> <g class="tabEvent">
let tabEventList = []; // event index -> layout event
let tabNoteNodes = []; // [{ node, start, activeEnd }] for §2.8 highlight
let tabActiveNodes = new Set();
let tabLastHighlightT = null;
let tabCursorIndex = -1;
let tabHoverIndex = -1;
let tabUiWired = false;

const tabRound = v => Math.round(v * 100) / 100;

function tabSvgText(attrs, text) {
  const node = el('text', attrs);
  node.textContent = text;
  return node;
}

function tabAnnounce(message) {
  const live = document.querySelector('#liveStatus');
  if (!live) return;
  live.textContent = '';
  // a fresh text node so repeated identical reads are still announced
  requestAnimationFrame(() => { live.textContent = message; });
}

/** §1 header (title + meta line) and notice. */
function renderResultHeader(header) {
  document.querySelector('#title').textContent = header.title;
  document.title = header.title;
  const meta = document.querySelector('#meta');
  meta.textContent = '';
  header.meta.forEach((item, i) => {
    if (i > 0) meta.append(document.createTextNode(' · '));
    let node;
    if (item.kind === 'link') {
      node = document.createElement('a');
      node.href = item.href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else {
      node = document.createElement('span');
    }
    node.textContent = item.text;
    if (item.title) node.title = item.title;
    node.className = `meta-${item.kind}`;
    meta.append(node);
  });
  const notice = document.querySelector('#notice');
  notice.textContent = header.notice || '';
  notice.title = header.notice || ''; // §1 one line; the full text stays reachable
  notice.hidden = !header.notice;
}

/** §1 empty and error states replace the TAB card body. */
function renderTabMessage(message, title) {
  if (title) document.querySelector('#tabTitle').textContent = title;
  const msg = document.querySelector('#tabMessage');
  msg.textContent = message;
  msg.hidden = false;
  document.querySelector('#tabLegend').hidden = true;
  const lines = document.querySelector('#tabLines');
  lines.hidden = true;
  lines.textContent = '';
  lines.removeAttribute('tabindex');
  hideTabTooltip();
}

function measureTabWidth() {
  const card = document.querySelector('#tabCard');
  if (!card) return TabLayout.contentWidthForViewport(window.innerWidth);
  const style = getComputedStyle(card);
  const inner = card.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
  return inner > 0 ? Math.floor(inner) : TabLayout.contentWidthForViewport(window.innerWidth); // §2.1.2
}

function renderTabLegend(legend) {
  const node = document.querySelector('#tabLegend');
  node.textContent = '';
  legend.items.forEach((item, i) => {
    if (i > 0) node.append(document.createTextNode(' · '));
    if (item.sample) {
      const sample = document.createElement('span');
      sample.className = `tabLegendSample tabLegend-${item.kind}`;
      sample.textContent = item.sample;
      sample.setAttribute('aria-hidden', 'true');
      node.append(sample, document.createTextNode(' '));
    }
    const text = document.createElement('span');
    text.textContent = item.text;
    node.append(text);
  });
  node.hidden = false;
}

function renderTabNote(group, layout, n) {
  const noteG = el('g', { class: `tabNote${n.low ? ' low' : ''}`, 'data-start': n.start, 'data-end': n.end });
  if (layout.kind === 'guitar') {
    const w = n.right - n.left;
    // §2.4.2 knockout behind the digits (also the §2.8 active box)
    noteG.append(el('rect', {
      class: 'tabKnock', x: tabRound(n.left - 2), y: tabRound(n.y - TabLayout.CONSTANTS.KNOCKOUT_HEIGHT / 2),
      width: tabRound(w + TabLayout.CONSTANTS.KNOCKOUT_PAD_X), height: TabLayout.CONSTANTS.KNOCKOUT_HEIGHT,
    }));
    const text = el('text', { class: 'tabFret', x: tabRound(n.left), y: tabRound(n.y + 4.5) });
    text.append(document.createTextNode(String(n.fret)));
    if (n.bend) {
      const b = el('tspan', { class: 'tabBend' }); // §2.4.3
      b.textContent = 'b';
      text.append(b);
    }
    noteG.append(text);
    if (n.low) { // §2.6 dotted underline 2 px below the digits
      noteG.append(el('line', { class: 'tabUnderline', x1: tabRound(n.left), x2: tabRound(n.left + n.digitsWidth), y1: tabRound(n.y + 6.5), y2: tabRound(n.y + 6.5) }));
    }
  } else {
    const C = TabLayout.CONSTANTS;
    for (const y of n.ledgers || []) { // §2.9 ledger lines
      noteG.append(el('line', { class: 'tabLedger', x1: tabRound(n.x - C.FLUTE_LEDGER_WIDTH / 2), x2: tabRound(n.x + C.FLUTE_LEDGER_WIDTH / 2), y1: y, y2: y }));
    }
    noteG.append(el('rect', { class: 'tabKnock tabKnockFlute', x: tabRound(n.x - 8), y: tabRound(n.y - 6.5), width: 16, height: 13 }));
    noteG.append(el('ellipse', {
      class: 'tabHead', cx: tabRound(n.x), cy: tabRound(n.y), rx: C.FLUTE_HEAD_RX, ry: C.FLUTE_HEAD_RY,
      transform: `rotate(${C.FLUTE_HEAD_ROTATE} ${tabRound(n.x)} ${tabRound(n.y)})`,
    }));
    if (n.sharp) noteG.append(tabSvgText({ class: 'tabSharp', x: tabRound(n.x - C.FLUTE_SHARP_OFFSET), y: tabRound(n.y + 4.5), 'text-anchor': 'middle' }, '♯'));
    if (n.low) noteG.append(el('line', { class: 'tabUnderline', x1: tabRound(n.x - 6), x2: tabRound(n.x + 6), y1: tabRound(n.y + 7), y2: tabRound(n.y + 7) }));
  }
  group.append(noteG);
  tabNoteNodes.push({ node: noteG, start: n.start, activeEnd: n.activeEnd });
}

function renderTabLine(layout, line) {
  const g = layout.geometry;
  const W = layout.width;
  const svg = el('svg', {
    class: 'tabLine', width: W, height: tabRound(g.height), viewBox: `0 0 ${W} ${tabRound(g.height)}`,
    role: 'group', 'aria-label': line.label, // §2.10
    'data-line': line.index, 'data-start': line.start, 'data-end': line.end,
  });
  svg.style.marginBottom = `${g.lineGap}px`;
  const endX = tabRound(line.endX); // §2.1.5 the last line is not stretched

  for (const s of g.staffLines) { // §2.2 strings / §2.9 staff
    svg.append(el('line', { class: 'tabString', x1: layout.gutter, x2: endX, y1: s.y, y2: s.y }));
    if (s.label) svg.append(tabSvgText({ class: 'tabStringLabel', x: g.stringLabelX, y: s.y + 4, 'text-anchor': 'end' }, s.label));
  }
  for (const bar of line.bars) { // §2.7 bar lines
    svg.append(el('line', { class: 'tabBar', x1: tabRound(bar.x), x2: tabRound(bar.x), y1: g.barY1, y2: g.barY2 }));
  }
  for (const tick of line.beatTicks) { // §2.7 beat / half-beat / second ticks rising from string 1
    svg.append(el('line', { class: `tabTick tabTick-${tick.kind}`, x1: tabRound(tick.x), x2: tabRound(tick.x), y1: g.tickBaseY, y2: g.tickBaseY - tick.h }));
  }
  for (const label of line.topLabels) {
    svg.append(tabSvgText({ class: 'tabTopLabel', x: tabRound(label.x), y: g.topLabelY, 'text-anchor': label.anchor }, label.text));
  }

  // §2.5 sustain bars first, so knockouts and heads sit on top
  for (const c of line.carrySustains) {
    svg.append(el('rect', { class: `tabSustain${c.low ? ' low' : ''}`, x: tabRound(c.x1), y: tabRound(c.y - 1), width: tabRound(c.x2 - c.x1), height: 2 }));
  }
  for (const ev of line.events) for (const n of ev.notes) {
    if (n.sustainX2 === null) continue;
    svg.append(el('rect', { class: `tabSustain${n.low ? ' low' : ''}`, x: tabRound(n.sustainX1), y: tabRound(n.y - 1), width: tabRound(n.sustainX2 - n.sustainX1), height: 2 }));
  }

  for (const ev of line.events) {
    // §2.10 each event is a <g data-t>; UX-04 hooks click-to-seek / drag-to-loop on it (no handlers here)
    const group = el('g', { class: 'tabEvent', 'data-t': ev.t, 'data-index': ev.index });
    group.append(el('rect', {
      class: 'tabHit', x: tabRound(ev.colLeft - 2), y: tabRound(g.staffTop - 10),
      width: tabRound(ev.colRight - ev.colLeft + 4), height: tabRound(g.rhythmY2 - g.staffTop + 10),
    }));
    for (const n of ev.notes) renderTabNote(group, layout, n);
    // §2.3.5 rhythm stem
    group.append(el('line', { class: `tabStem${ev.stemLow ? ' low' : ''}`, x1: tabRound(ev.x), x2: tabRound(ev.x), y1: g.rhythmY1, y2: g.rhythmY2 }));
    svg.append(group);
    tabEventNodes[ev.index] = group;
    tabEventList[ev.index] = ev;
  }
  return svg;
}

/** Lays out and draws the TAB card for the current `result` at the card's current width. */
function renderTab() {
  const previousT = tabCursorIndex >= 0 ? tabEventList[tabCursorIndex]?.t : null;
  const width = measureTabWidth();
  tabLayout = TabLayout.layoutTab(result, width);
  tabRenderedWidth = width;
  tabEventNodes = [];
  tabEventList = [];
  tabNoteNodes = [];
  tabActiveNodes = new Set();
  hideTabTooltip();

  document.querySelector('#tabTitle').textContent = tabLayout.title; // §1 "TAB" or "Melody"
  if (tabLayout.kind === 'empty') {
    renderTabMessage(tabLayout.message);
    return;
  }
  document.querySelector('#tabMessage').hidden = true;
  renderTabLegend(tabLayout.legend);

  const container = document.querySelector('#tabLines');
  container.textContent = '';
  const frag = document.createDocumentFragment();
  tabLayout.lines.forEach(line => frag.append(renderTabLine(tabLayout, line)));
  container.append(frag);
  container.hidden = false;
  // §7.2 one tab stop with a roving cursor
  container.setAttribute('tabindex', '0');
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', TabLayout.tabAriaLabel(tabLayout));
  wireTabUi(container);

  tabCursorIndex = -1;
  if (previousT !== null && previousT !== undefined && tabEventList.length) {
    let best = 0;
    tabEventList.forEach((ev, i) => { if (Math.abs(ev.t - previousT) < Math.abs(tabEventList[best].t - previousT)) best = i; });
    setTabCursor(best, { announce: false, tooltip: document.activeElement === container });
  }
  if (tabLastHighlightT !== null) tabHighlightAt(tabLastHighlightT);
}

function scheduleTabRelayout() {
  clearTimeout(tabResizeTimer);
  tabResizeTimer = setTimeout(() => { // §2.10 debounced 150 ms
    if (!result || measureTabWidth() === tabRenderedWidth) return;
    renderTab();
  }, TAB_RESIZE_DEBOUNCE_MS);
}

/**
 * §2.8 active notes: start <= t < max(end, start + 0.15) get the .active class
 * (--accent, weight 700, 1 px box). t is capture time in seconds; null clears.
 * Called by updatePlaybackUi today; UX-04's transport should call it every frame.
 */
function tabHighlightAt(seconds) {
  tabLastHighlightT = Number.isFinite(seconds) ? seconds : null;
  const next = new Set();
  if (tabLastHighlightT !== null) {
    for (const item of tabNoteNodes) {
      if (item.start <= tabLastHighlightT && tabLastHighlightT < item.activeEnd) next.add(item.node);
    }
  }
  for (const node of tabActiveNodes) if (!next.has(node)) node.classList.remove('active');
  for (const node of next) if (!tabActiveNodes.has(node)) node.classList.add('active');
  tabActiveNodes = next;
}

function showTabTooltip(index) {
  const tooltip = document.querySelector('#tabTooltip');
  const ev = tabEventList[index];
  const node = tabEventNodes[index];
  const card = document.querySelector('#tabCard');
  if (!tooltip || !ev || !node || !card) return;
  tooltip.textContent = '';
  for (const line of ev.tooltip) { // §2.8 one line per note
    const row = document.createElement('div');
    row.textContent = line;
    tooltip.append(row);
  }
  tooltip.hidden = false;
  const anchor = (node.querySelector('.tabHit') || node).getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const centre = anchor.left - cardRect.left + anchor.width / 2;
  const left = Math.max(0, Math.min(card.clientWidth - width, centre - width / 2));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(anchor.bottom - cardRect.top + 4)}px`;
}

function hideTabTooltip() {
  const tooltip = document.querySelector('#tabTooltip');
  if (tooltip) tooltip.hidden = true;
}

function setTabCursor(index, { announce = true, tooltip = true } = {}) {
  if (!tabEventList.length) return;
  const i = Math.max(0, Math.min(tabEventList.length - 1, index));
  document.querySelectorAll('#tabLines .tabCursor').forEach(node => node.remove());
  tabCursorIndex = i;
  const ev = tabEventList[i];
  const group = tabEventNodes[i];
  // §7.2 roving cursor, 2 px --focus box (shown only while the TAB has focus, see result.css)
  group.append(el('rect', {
    class: 'tabCursor', x: tabRound(ev.colLeft - 3), y: tabRound(tabLayout.geometry.staffTop - 11),
    width: tabRound(ev.colRight - ev.colLeft + 6), height: tabRound(tabLayout.geometry.rhythmY2 - tabLayout.geometry.staffTop + 12),
    rx: 3,
  }));
  group.closest('svg')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (tooltip) showTabTooltip(i);
  if (announce) tabAnnounce(ev.speech); // §7.2 live read
}

function wireTabUi(container) {
  if (tabUiWired) return;
  tabUiWired = true;

  // §2.8 hover tooltip (event delegation; the <g> nodes are rebuilt on every relayout)
  container.addEventListener('mouseover', event => {
    const group = event.target.closest?.('.tabEvent');
    if (!group) return;
    const index = Number(group.dataset.index);
    if (index === tabHoverIndex) return;
    tabHoverIndex = index;
    showTabTooltip(index);
  });
  container.addEventListener('mouseleave', () => {
    tabHoverIndex = -1;
    if (document.activeElement === container && tabCursorIndex >= 0) showTabTooltip(tabCursorIndex);
    else hideTabTooltip();
  });

  // §7.2 keyboard model (focus shows the tooltip too, §7.5)
  container.addEventListener('focus', () => {
    if (!tabEventList.length) return;
    // keyboard focus shows the cursor tooltip; a mouse click that focuses the TAB does not
    const keyboard = container.matches(':focus-visible');
    setTabCursor(tabCursorIndex >= 0 ? tabCursorIndex : 0, { announce: false, tooltip: keyboard });
  });
  container.addEventListener('blur', () => hideTabTooltip());
  container.addEventListener('keydown', event => {
    if (!tabEventList.length) return;
    let next = null;
    switch (event.key) {
      case 'ArrowLeft': next = tabCursorIndex - 1; break; // Shift+← / → loop extension: UX-04
      case 'ArrowRight': next = tabCursorIndex + 1; break;
      case 'Home': next = 0; break;
      case 'End': next = tabEventList.length - 1; break;
      case 'Escape': hideTabTooltip(); event.preventDefault(); return;
      case 'Enter': {
        // UX-04 hook: the transport listens for `tabseek` and seeks to detail.t (capture seconds)
        const ev = tabEventList[tabCursorIndex];
        if (ev) container.dispatchEvent(new CustomEvent('tabseek', { bubbles: true, detail: { t: ev.t, index: ev.index } }));
        event.preventDefault();
        return;
      }
      default: return;
    }
    event.preventDefault();
    setTabCursor(Math.max(0, Math.min(tabEventList.length - 1, next)));
  });
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
  const musicalRole = note.musicalRole || 'unknown';
  const maxSourceDuration = musicalRole === 'lead' ? 1.10 : musicalRole === 'double-stop' ? 0.52 : 0.38;
  const sourceDuration = Math.max(0.05, Math.min(note.end - note.start, sourceRemaining, maxSourceDuration));
  const wallDuration = sourceDuration / playbackRate;
  const releaseTail = musicalRole === 'lead'
    ? Math.min(0.12 / playbackRate, 0.18)
    : Math.min(0.045 / playbackRate, 0.07);
  const maxAudibleDuration = musicalRole === 'lead' ? 1.20 : musicalRole === 'double-stop' ? 0.58 : 0.44;
  const audibleDuration = Math.max(0.12, Math.min(wallDuration + releaseTail, maxAudibleDuration));
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
  const peak = 0.032 + confidence * 0.045;
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
    const noisePeak = 0.010 + confidence * 0.014;
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
  tabHighlightAt(sourceElapsed); // §2.8 active notes on the TAB

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
  masterGain.gain.setValueAtTime(result?.instrument === 'guitar' ? 1.28 : 1.12, audioContext.currentTime);
  const playbackCompressor = audioContext.createDynamicsCompressor();
  playbackCompressor.threshold.setValueAtTime(-16, audioContext.currentTime);
  playbackCompressor.knee.setValueAtTime(18, audioContext.currentTime);
  playbackCompressor.ratio.setValueAtTime(4, audioContext.currentTime);
  playbackCompressor.attack.setValueAtTime(0.003, audioContext.currentTime);
  playbackCompressor.release.setValueAtTime(0.18, audioContext.currentTime);
  masterGain.connect(playbackCompressor);
  playbackCompressor.connect(audioContext.destination);
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
  tabHighlightAt(null);
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
    renderTabMessage(TabLayout.MESSAGES.loadError.replace('{message}', error?.message || String(error))); // §1
    return;
  }

  if (!result) {
    renderTabMessage(TabLayout.MESSAGES.noResult); // §1
    return;
  }

  renderResultHeader(TabLayout.buildHeader(result)); // §1 header + notice
  renderTab(); // §2
  window.addEventListener('resize', scheduleTabRelayout); // §2.10
  renderTable(result.notes || [], result.instrument);

  document.querySelector('#playTen').addEventListener('click', () => startPlayback(90, 1));
  document.querySelector('#playTenSlow').addEventListener('click', () => startPlayback(90, 0.75));
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
