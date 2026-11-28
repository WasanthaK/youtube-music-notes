// Plain-Node tests for extension/tab-layout.js (UX-03, docs/UX_SPEC.md §1/§2).
// Run from extension/: node scripts/test-tab-layout.mjs
//
// Why vm and not createRequire: extension/package.json declares "type": "module", so Node treats
// every .js file in extension/ as ESM, including under require(). Loaded that way, tab-layout.js has
// no `module` binding and its UMD wrapper never reaches the `module.exports` branch. tab-layout.js has
// to stay a plain .js classic script for result.html, so the test evaluates its source with node:vm in
// a CommonJS-shaped sandbox ({ module, exports }) instead. That runs the real CommonJS branch, with no
// window/self/document/chrome in scope, which also proves the file is DOM-free.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// extension/package.json is "type": "module", so createRequire('../tab-layout.js') would load the
// file as ESM (no `module` binding). Evaluate it as CommonJS instead: this runs the UMD
// `module.exports` branch with no window/self/document/chrome in scope.
function loadTabLayout() {
  const path = new URL('../tab-layout.js', import.meta.url);
  const sandbox = { module: { exports: {} }, URL, console };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), sandbox, { filename: path.pathname });
  assert.equal(typeof sandbox.module.exports.layoutTab, 'function', 'tab-layout.js must export layoutTab');
  assert.equal(sandbox.TabLayout, undefined, 'CommonJS load must not leak a global');
  return sandbox.module.exports;
}
const TL = loadTabLayout();
const C = TL.CONSTANTS;

const WIDE = 1156; // W -> U = W - 56 = 1100 (≥ 640)
const NARROW = 616; // W -> U = 560 (< 640)
const plain = v => JSON.parse(JSON.stringify(v)); // vm objects live in another realm
const same = (a, b, msg) => assert.deepEqual(plain(a), b, msg);
const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

let failures = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.error(`not ok - ${name}\n  ${error?.stack || error}`); }
}

// ---------------------------------------------------------------- fixtures
function beats(bpmPulse, duration, phase = 0) {
  const period = 60 / bpmPulse;
  const out = [];
  for (let t = phase; t <= duration + 1e-9; t += period) out.push(Number(t.toFixed(6)));
  return out;
}

function tempo({ bpm, mode = 'base-pulse', duration = 90, phase = 0, confidence = 0.6 }) {
  const pulseBpm = mode === 'double-pulse' ? bpm * 2 : bpm;
  return { available: true, bpm, pulseBpm, confidence, metricalMode: mode, beatTimes: beats(pulseBpm, duration, phase) };
}

let nextChord = 0;
function g(start, string, fret, extra = {}) {
  return {
    start, end: start + 0.2, midi: 40 + fret, name: 'E2', confidence: 0.8,
    guitar: { string, stringName: TL.GUITAR_STRING_NAMES[string - 1], fret },
    chordId: nextChord++, ...extra,
  };
}

function guitarResult(notes, { tempo: tp = null, duration = 90, warnings, benchmark } = {}) {
  return {
    title: 'Fixture', instrument: 'guitar', mode: 'transcribe', engine: 'guitar-ear-v0.2d-test',
    duration_seconds: duration,
    warnings: warnings || ['Automatic transcription is approximate on dense full mixes.'],
    benchmark: benchmark === undefined ? { mode: 'fixed-90s-v1', videoId: 'abc', videoUrl: 'https://www.youtube.com/watch?v=abc', startSeconds: 0, endSeconds: 90 } : benchmark,
    notes,
    summary: tp ? { tempo: tp } : {},
  };
}

function sparseNotes(duration, step = 1.0) {
  const notes = [];
  for (let t = 0.1; t < duration; t += step) notes.push(g(Number(t.toFixed(3)), 3, 2));
  return notes;
}

const allNotes = layout => layout.lines.flatMap(l => l.events.flatMap(e => e.notes));

// ---------------------------------------------------------------- tests
test('tempo known, base-pulse 96 BPM -> 4 bars per line, 10 s lines (§2.1.3)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(90), { tempo: tempo({ bpm: 96 }) }), WIDE);
  assert.equal(L.kind, 'guitar');
  assert.equal(L.tempo.barsPerLine, 4);
  assert.equal(L.lines.length, 9);
  for (const line of L.lines) close(line.scaleEnd - line.start, 10, 1e-6, 'line span');
  assert.equal(L.lines[0].bars.length, 4);
  assert.equal(L.lines[0].beatTicks.length, 16);
  assert.equal(L.lines[1].firstBar, 5);
  assert.equal(L.lines[1].lastBar, 8);
  close(L.lines[1].bars[0].x, C.GUTTER, 1e-6, 'first bar line at gutter (§2.7)');
  assert.match(L.lines[1].topLabels[0].text, /^Bar 5 · 0:10$/);
  assert.equal(L.lines[1].topLabels[1].text, '6');
  assert.match(L.lines[2].label, /^Line 3, bars 9 to 12, 0:20 to 0:30, \d+ notes$/);
  assert.ok(L.legend.text.includes('Bars assume 4/4'));
  assert.ok(L.header.meta.some(m => m.kind === 'bpm' && m.text === '96 BPM'));
});

test('double-pulse halves beatTimes into quarters, half-beat ticks (§2.1.3, F3, §2.7)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(90), { tempo: tempo({ bpm: 96, mode: 'double-pulse' }) }), WIDE);
  close(L.tempo.period, 0.625, 1e-6, 'quarter period');
  close(L.lines[0].scaleEnd - L.lines[0].start, 10, 1e-6);
  const beat = L.lines[0].beatTicks.filter(t => t.kind === 'beat');
  const half = L.lines[0].beatTicks.filter(t => t.kind === 'half');
  assert.equal(beat.length, 16);
  assert.equal(half.length, 16);
  assert.ok(half.every(t => t.h === C.HALF_TICK_H));
  assert.ok(beat.every(t => t.h === C.BEAT_TICK_H));
});

test('bpm 70 -> 2 bars per line, bpm 170 -> 8 bars per line (§2.1.3)', () => {
  const slow = TL.layoutTab(guitarResult(sparseNotes(90, 1.5), { tempo: tempo({ bpm: 70 }) }), WIDE);
  assert.equal(slow.tempo.barsPerLine, 2);
  close(slow.lines[0].scaleEnd - slow.lines[0].start, 8 * 60 / 70, 1e-4);
  const fast = TL.layoutTab(guitarResult(sparseNotes(90, 1.5), { tempo: tempo({ bpm: 170 }) }), WIDE);
  assert.equal(fast.tempo.barsPerLine, 8);
  close(fast.lines[0].scaleEnd - fast.lines[0].start, 32 * 60 / 170, 1e-4);
});

test('no tempo -> 8 s lines, second ticks, m:ss every 2 s (§2.1.4, §2.7)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(90)), WIDE);
  assert.equal(L.tempo, null);
  assert.equal(L.lines.length, 12);
  close(L.lines[0].start, 0); close(L.lines[0].end, 8);
  close(L.lines[3].start, 24); close(L.lines[3].end, 32);
  assert.equal(L.lines[0].bars.length, 0);
  assert.equal(L.lines[0].beatTicks.length, 8);
  assert.ok(L.lines[0].beatTicks.every(t => t.kind === 'second'));
  same(L.lines[0].topLabels.map(l => l.text), ['0:00', '0:02', '0:04', '0:06']);
  close(L.lines[0].pxPerSecond, 1100 / 8);
  assert.ok(!L.legend.text.includes('Bars assume 4/4'));
  assert.match(L.lines[0].label, /^Line 1, 0:00 to 0:08, \d+ notes$/);
});

test('time labels use video time when benchmark.startSeconds exists (§2.7, Q2)', () => {
  const r = guitarResult(sparseNotes(30), { duration: 30, benchmark: { videoUrl: 'https://www.youtube.com/watch?v=x', startSeconds: 83.4, endSeconds: 113.4 } });
  const L = TL.layoutTab(r, WIDE);
  assert.equal(L.lines[0].topLabels[0].text, '1:23');
  assert.equal(L.header.meta[0].href, 'https://www.youtube.com/watch?v=x&t=83s');
  assert.equal(L.header.meta[1].text, '1:23–1:53');
  assert.equal(L.header.meta[2].text, '30.0 s');
});

test('pickup when Q[0] > 0.05 s: line 1 starts at 0, bar 1 at Q[0] (§2.1.3)', () => {
  const tp = tempo({ bpm: 120, phase: 0.4, duration: 30 });
  const L = TL.layoutTab(guitarResult([g(0.1, 1, 3), ...sparseNotes(30, 2)], { tempo: tp, duration: 30 }), WIDE);
  const l0 = L.lines[0];
  assert.equal(l0.pickup, true);
  close(l0.start, 0);
  close(l0.scaleEnd, 0.4 + 16 * 0.5, 1e-6);
  assert.ok(l0.bars[0].x > C.GUTTER + 1);
  assert.equal(l0.firstBar, 1);
  assert.equal(l0.topLabels[0].text, 'Bar 1 · 0:00');
  assert.ok(l0.events[0].t < 0.4, 'pickup note on line 1');
  close(L.lines[1].start, 8.4, 1e-6);
  // no pickup when Q[0] <= 0.05
  const L2 = TL.layoutTab(guitarResult(sparseNotes(30, 2), { tempo: tempo({ bpm: 120, phase: 0.04, duration: 30 }), duration: 30 }), WIDE);
  assert.equal(L2.lines[0].pickup, false);
  close(L2.lines[0].start, 0.04, 1e-6);
});

test('same chordId stacks at one x; string 1 is the top row (§2.3.2, §2.3.4, §2.2)', () => {
  const chord = [1, 2, 3].map((s, i) => ({ ...g(1.0, s, [0, 1, 0][i]), chordId: 99 }));
  const L = TL.layoutTab(guitarResult([...chord, g(3, 6, 5)]), WIDE);
  const ev = L.lines[0].events[0];
  assert.equal(L.lines[0].events.length, 2);
  assert.equal(ev.notes.length, 3);
  assert.ok(ev.notes.every(n => n.x === ev.x));
  same(ev.notes.map(n => n.row), [0, 1, 2]);
  assert.ok(ev.notes[0].y < ev.notes[1].y && ev.notes[1].y < ev.notes[2].y);
  close(ev.notes[0].y, L.geometry.staffTop);
  const low = L.lines[0].events[1].notes[0];
  assert.equal(low.row, 5);
  close(low.y, L.geometry.staffBottom);
  assert.equal(ev.speech, '0:01.0, chord: string 1 fret 0, string 2 fret 1, string 3 fret 0');
});

test('missing chordId groups within 65 ms of the first note (§2.3.3)', () => {
  const notes = [
    { ...g(2.000, 1, 0), chordId: undefined },
    { ...g(2.040, 2, 1), chordId: undefined },
    { ...g(2.064, 3, 2), chordId: undefined },
    { ...g(2.070, 4, 2), chordId: undefined },
  ];
  const L = TL.layoutTab(guitarResult(notes), WIDE);
  const evs = L.lines[0].events;
  assert.equal(evs.length, 2);
  assert.equal(evs[0].notes.length, 3);
  close(evs[0].t, 2.0);
  close(evs[1].t, 2.07);
});

test('same string inside one event: higher confidence at x, other nudged (§2.3.4, §2.4.4)', () => {
  const notes = [
    { ...g(4.00, 3, 5, { confidence: 0.5 }), chordId: null },
    { ...g(4.03, 3, 7, { confidence: 0.9 }), chordId: null },
  ];
  const L = TL.layoutTab(guitarResult(notes), WIDE);
  const ev = L.lines[0].events[0];
  const strong = ev.notes.find(n => n.fret === 7);
  const weak = ev.notes.find(n => n.fret === 5);
  assert.equal(strong.nudge, 0);
  close(weak.nudge, 6, 1e-9, 'capped nudge');
  close(strong.x, ev.x);
});

test('overlap nudge is capped at 6 px (§2.4.4)', () => {
  // 8 s line at U = 1100 -> 137.5 px/s. "12b" is 23 px wide (8 left of x, 15 right).
  // 0.153 s apart = 21.04 px: not dense (≥ 20 px) but the next glyph's left edge is 3.96 px too close.
  const notes = [g(1.0, 2, 12, { bendSemitones: 1 }), g(1.153, 2, 12), g(5, 2, 1)];
  const L = TL.layoutTab(guitarResult(notes, { duration: 8 }), WIDE);
  assert.equal(L.lines[0].split, 0);
  const [a, b] = L.lines[0].events.map(e => e.notes[0]);
  assert.equal(a.nudge, 0);
  assert.equal(a.text, '12b');
  close(b.nudge, 25 - 1.153 * 137.5 + 1.0 * 137.5, 1e-6, 'nudge = overlap');
  close(b.left, a.right + 2, 1e-6);
  // a forced big overlap still caps at 6 and the stem x is unchanged
  const L2 = TL.layoutTab(guitarResult([g(1.0, 2, 12), g(1.01, 2, 12)], { duration: 8 }), WIDE);
  const evs = L2.lines.flatMap(l => l.events);
  const n2 = evs[1].notes[0];
  close(n2.nudge, 6);
  assert.ok(evs[1].x < n2.x, 'stem stays at the time x');
});

test('dense line is split once into halves (§2.1.7)', () => {
  // gap 0.12 s * 137.5 px/s = 16.5 px < 20 -> split; halves = 4 s -> 33 px gap, no second split
  const notes = [g(1.0, 4, 3), g(1.12, 4, 5), g(6, 1, 0)];
  const L = TL.layoutTab(guitarResult(notes, { duration: 16 }), WIDE);
  assert.equal(L.lines[0].split, 1);
  assert.equal(L.lines[1].split, 2);
  close(L.lines[0].start, 0); close(L.lines[0].end, 4);
  close(L.lines[1].start, 4); close(L.lines[1].end, 8);
  assert.equal(L.lines[2].split, 0);
  close(L.lines[2].start, 8);
  // even a 1 ms gap splits only once
  const L2 = TL.layoutTab(guitarResult([g(1.0, 4, 3), g(1.001, 4, 5)], { duration: 8 }), WIDE);
  assert.equal(L2.lines.length, 2);
  same(L2.lines.map(l => l.split), [1, 2]);
  // tempo: halves are half the bars
  const L3 = TL.layoutTab(guitarResult([g(1.0, 4, 3), g(1.05, 4, 5), g(12, 2, 2)], { tempo: tempo({ bpm: 96, duration: 20 }), duration: 20 }), WIDE);
  close(L3.lines[0].scaleEnd - L3.lines[0].start, 5, 1e-6);
  assert.equal(L3.lines[1].topLabels[0].text, 'Bar 3 · 0:05');
});

test('sustain only when held ≥ 0.40 s; clipped before the next glyph on the same string (§2.5)', () => {
  const notes = [
    g(1.0, 1, 3, { end: 1.39 }), // too short
    g(2.0, 2, 3, { end: 2.6 }), // free: to x(end)
    g(3.0, 3, 3, { end: 4.5 }), // clipped by the next glyph on string 3 at 3.5
    g(3.5, 3, 5),
    g(3.2, 4, 0, { end: 3.6 }), // 0.4 s exactly; to x(end)
    g(5.0, 5, 0, { end: 5.45 }), // ≥ 0.40 s but the next glyph on string 5 is too close -> < 12 px, not drawn (this pair also splits the line)
    g(5.06, 5, 2),
  ];
  const L = TL.layoutTab(guitarResult(notes, { duration: 8 }), WIDE);
  const line = L.lines[0];
  const find = (s, t) => allNotes(L).find(n => n.string === s && Math.abs(n.start - t) < 1e-9);
  const xOf = t => C.GUTTER + t * line.pxPerSecond;
  assert.equal(find(1, 1.0).sustainX2, null);
  const free = find(2, 2.0);
  close(free.sustainX1, free.right); close(free.sustainX2, xOf(2.6));
  const clipped = find(3, 3.0);
  const next = find(3, 3.5);
  close(clipped.sustainX2, next.left - 2);
  assert.ok(clipped.sustainX2 < xOf(4.5));
  close(find(4, 3.2).sustainX2, xOf(3.6));
  assert.equal(find(5, 5.0).sustainX2, null);
});

test('sustain clipped at the line end and continued from the next gutter (§2.5)', () => {
  const notes = [g(7.5, 1, 7, { end: 8.8 }), g(12, 2, 1)];
  const L = TL.layoutTab(guitarResult(notes, { duration: 16 }), WIDE);
  const n = L.lines[0].events[0].notes[0];
  close(n.sustainX2, L.lines[0].endX);
  const carry = L.lines[1].carrySustains;
  assert.equal(carry.length, 1);
  close(carry[0].x1, C.GUTTER);
  close(carry[0].x2, C.GUTTER + 0.8 * L.lines[1].pxPerSecond);
});

test('low confidence: < 0.48 or uncertain-presence (§2.6)', () => {
  assert.equal(TL.isLowConfidence({ confidence: 0.47 }, 'guitar'), true);
  assert.equal(TL.isLowConfidence({ confidence: 0.48 }, 'guitar'), false);
  assert.equal(TL.isLowConfidence({ confidence: 0.9, guitarEarSupport: 'uncertain-presence' }, 'guitar'), true);
  assert.equal(TL.isLowConfidence({ confidence: 0.9, guitarEarSupport: 'presence' }, 'guitar'), false);
  const L = TL.layoutTab(guitarResult([
    { ...g(1, 1, 0, { confidence: 0.3 }), chordId: 5 }, { ...g(1, 2, 1, { confidence: 0.9 }), chordId: 5 },
    g(2, 3, 2, { confidence: 0.2 }),
  ]), WIDE);
  const [chord, single] = L.lines[0].events;
  assert.equal(chord.stemLow, false);
  assert.equal(single.stemLow, true);
  assert.equal(single.speech, '0:02.0, string 3 fret 2, low confidence');
  assert.ok(L.legend.text.includes('low confidence (< 48 %)'));
});

test('flute: sharps get ♯ on the right natural step; 8 s lines; low < 0.30 (§2.9)', () => {
  same(TL.fluteStep(64), { step: 0, naturalIndex: 2, sharp: false }); // E4 bottom line
  same(TL.fluteStep(66), { step: 1, naturalIndex: 3, sharp: true }); // F♯4 on F
  same(TL.fluteStep(61), { step: -2, naturalIndex: 0, sharp: true }); // C♯4 on C
  same(TL.fluteStep(73), { step: 5, naturalIndex: 0, sharp: true }); // C♯5
  assert.equal(TL.fluteStep(77).step, 8); // F5 top line
  const r = {
    title: 'Flute', instrument: 'flute', engine: 'flute-basic-pitch-v1', duration_seconds: 20, warnings: ['approx'],
    notes: [
      { start: 1, end: 1.6, midi: 66, name: 'F#4', confidence: 0.6 },
      { start: 2, end: 2.2, midi: 81, name: 'A5', confidence: 0.25 },
      { start: 9, end: 9.2, midi: 60, name: 'C4', confidence: 0.5 },
    ],
    summary: { tempo: { available: true, confidence: 0.9, bpm: 100, beatTimes: [0, 0.6, 1.2], metricalMode: 'base-pulse' } },
  };
  const L = TL.layoutTab(r, WIDE);
  assert.equal(L.kind, 'flute');
  assert.equal(L.title, 'Melody');
  assert.equal(L.tempo, null, 'flute ignores tempo');
  close(L.lines[0].scaleEnd, 8);
  const ns = allNotes(L);
  assert.equal(ns[0].sharp, true); assert.equal(ns[0].step, 1);
  assert.equal(ns[1].low, true); assert.equal(ns[1].ledgers.length, 1); // A5 = step 10 -> one ledger
  assert.equal(ns[2].ledgers.length, 1); // C4 = step -2 -> one ledger
  assert.ok(ns[0].sustainX2 !== null);
  assert.equal(L.geometry.topStep, 11); assert.equal(L.geometry.bottomStep, -3);
  assert.ok(L.legend.text.includes('< 30 %'));
  assert.ok(ns[0].y > ns[1].y, 'higher pitch drawn higher');
});

test('last line keeps px-per-second and is not stretched (§2.1.5)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(21), { duration: 21 }), WIDE);
  const last = L.lines[L.lines.length - 1];
  close(last.start, 16); close(last.end, 21); close(last.scaleEnd, 24);
  close(last.pxPerSecond, L.lines[0].pxPerSecond);
  close(last.endX, C.GUTTER + 5 * last.pxPerSecond);
  assert.ok(last.endX < C.GUTTER + L.unitWidth);
  // tempo
  const T = TL.layoutTab(guitarResult(sparseNotes(25, 2), { tempo: tempo({ bpm: 96, duration: 25 }), duration: 25 }), WIDE);
  const tl = T.lines[T.lines.length - 1];
  close(tl.end, 25); close(tl.scaleEnd - tl.start, 10, 1e-6);
});

test('a sustain past duration_seconds does not add an empty line (§2.1.5)', () => {
  const L = TL.layoutTab(guitarResult([g(1, 1, 0), g(7.0, 1, 3, { end: 9.5 })], { duration: 8 }), WIDE);
  assert.equal(L.lines.length, 1);
  close(L.lines[0].end, 8);
  close(L.lines[0].events[1].notes[0].sustainX2, L.lines[0].endX);
  // an onset at/after the end is clamped into the last line, not given a sliver line
  const late = TL.layoutTab(guitarResult([g(1, 1, 0), g(8.004, 2, 3)], { duration: 8 }), WIDE);
  assert.equal(late.lines.length, 1);
  assert.equal(late.lines[0].events.length, 2);
  close(late.lines[0].events[1].x, late.lines[0].endX);
});

test('gutter 44 / labels at 30: a first-beat glyph clears the string label by ≥ 4 px (§2.1.2, §2.2)', () => {
  assert.equal(C.GUTTER, 44);
  assert.equal(C.STRING_LABEL_X, 30);
  const labelRight = C.STRING_LABEL_X; // labels are right-aligned (text-anchor end) at this x
  for (const [tp, width] of [[null, WIDE], [tempo({ bpm: 96, duration: 20 }), WIDE], [tempo({ bpm: 96, duration: 20 }), NARROW]]) {
    // a two-digit chord and a bent fret on the first beat of line 2 (the widest left extents)
    const t0 = tp ? 10 : 8;
    const notes = [
      { ...g(t0, 1, 12, { bendSemitones: 1 }), chordId: 500 }, { ...g(t0, 2, 10), chordId: 500 }, { ...g(t0, 3, 3), chordId: 500 },
      g(0.5, 4, 2), g(t0 + 3, 4, 2),
    ];
    const L = TL.layoutTab(guitarResult(notes, { tempo: tp, duration: 20 }), width);
    assert.equal(L.unitWidth, width - 56);
    const line = L.lines.find(l => Math.abs(l.start - t0) < 1e-6);
    assert.ok(line, `a line starts at ${t0}`);
    const ev = line.events[0];
    close(ev.t, line.start);
    close(ev.x, L.gutter);
    if (tp) close(line.bars[0].x, L.gutter, 1e-6, 'first bar line at the gutter');
    for (const n of ev.notes) assert.ok(n.left >= labelRight + 4, `glyph "${n.text}" left ${n.left} must be ≥ ${labelRight + 4}`);
    close(line.endX, L.gutter + (line.end - line.start) * line.pxPerSecond);
  }
});

test('narrow width (U < 640) halves the span (§2.1.6)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(90, 1.5)), NARROW);
  assert.equal(L.unitWidth, 560);
  close(L.lines[0].scaleEnd - L.lines[0].start, 4);
  const T = TL.layoutTab(guitarResult(sparseNotes(90, 1.5), { tempo: tempo({ bpm: 96 }) }), NARROW);
  assert.equal(T.tempo.barsPerLine, 2);
  close(T.lines[0].scaleEnd - T.lines[0].start, 5, 1e-6);
});

test('empty notes -> kind empty with the §1 message; null -> no-result', () => {
  const L = TL.layoutTab(guitarResult([]), WIDE);
  assert.equal(L.kind, 'empty');
  assert.equal(L.message, 'No notes were detected in this capture.');
  assert.equal(L.header.title, 'Fixture');
  const N = TL.layoutTab(null, WIDE);
  assert.equal(N.kind, 'empty');
  assert.equal(N.reason, 'no-result');
  assert.match(N.message, /^No transcription yet\./);
});

test('header: notice only for warnings[1..]; engine short label (§1)', () => {
  const one = TL.buildHeader(guitarResult([], { warnings: ['a'] }));
  assert.equal(one.notice, null);
  const two = TL.buildHeader(guitarResult([], { warnings: ['a', 'b', 'c'] }));
  assert.equal(two.notice, 'b c');
  assert.equal(TL.engineShortLabel('guitar-ear-v0.2e-rhythm'), 'Guitar Ear 0.2e');
  assert.equal(TL.engineShortLabel('guitar-basic-pitch-ensemble-v1.2'), 'Basic Pitch (fallback)');
  assert.equal(TL.engineShortLabel('flute-basic-pitch-v1'), 'Basic Pitch (flute)');
  assert.equal(TL.engineShortLabel('mystery-x'), 'mystery-x');
  const engine = two.meta.find(m => m.kind === 'engine');
  assert.equal(engine.title, 'guitar-ear-v0.2d-test');
  assert.equal(engine.text, 'Guitar Ear 0.2d');
});

test('active window and tooltip text (§2.8)', () => {
  const n = { start: 1, end: 1.05 };
  assert.equal(TL.isActiveAt(n, 1), true);
  assert.equal(TL.isActiveAt(n, 1.14), true);
  assert.equal(TL.isActiveAt(n, 1.15), false);
  assert.equal(TL.isActiveAt({ start: 1, end: 2 }, 1.9), true);
  const L = TL.layoutTab(guitarResult([g(12.35, 1, 0, { name: 'E4', end: 12.75, confidence: 0.72, musicalRole: 'lead', guitarEarSupport: 'attack' })], { duration: 20 }), WIDE);
  assert.equal(L.lines[1].events[0].tooltip[0], 'E4 · string 1 fret 0 · 0:12.35 · held 0.40 s · 72 % · role lead · support attack');
  assert.ok(L.lines.every(l => l.events.every(e => Number.isFinite(e.t))));
});

test('x <-> t mapping round-trips (hook for UX-04)', () => {
  const L = TL.layoutTab(guitarResult(sparseNotes(30), { duration: 30 }), WIDE);
  const line = L.lines[1];
  const x = TL.timeToX(line, 11.25, L);
  close(TL.xToTime(line, x, L), 11.25);
  assert.equal(TL.contentWidthForViewport(1400), 1160);
  assert.equal(TL.contentWidthForViewport(800), 712);
});

if (failures) {
  console.error(`${failures} test(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`TAB_LAYOUT_TEST_OK (${passed} tests)`);
