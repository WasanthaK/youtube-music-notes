/*
 * tab-layout.js: pure TAB / melody layout maths for result.html (UX-03).
 *
 * Source of truth: docs/UX_SPEC.md §1 (header, notice, empty states) and §2
 * (TAB rendering rules). Rule numbers are quoted in comments as "§2.x.y".
 *
 * No DOM, no chrome.*, no fetch. Loads as a classic browser script (exposes
 * `self.TabLayout`) and as a CommonJS module in Node. extension/package.json has
 * "type": "module", so Node treats this .js file as ESM under require(); the test
 * (scripts/test-tab-layout.mjs) therefore evaluates it in a CommonJS-shaped vm context.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TabLayout = factory();
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const C = Object.freeze({
    // §2.1.2 horizontal frame
    GUTTER: 44, // string labels + 14 px clear space before a first-beat glyph
    RIGHT_PAD: 12,
    U_INSET: 56, // U = W - 56 (gutter 44 + right pad 12)
    PAGE_MAX: 1200, // §1 max content width
    PAGE_SIDE_PADDING_TOTAL: 48, // §2.1.2 "viewport - 48"
    CARD_PADDING_TOTAL: 40, // §2.1.2 "- 40" (card padding 20 each side)
    // §2.1.3 / §2.1.4 line spans
    BEATS_PER_BAR: 4, // 4/4 assumed (F4, Q1)
    NO_TEMPO_LINE_SECONDS: 8,
    PICKUP_MIN_SECONDS: 0.05,
    NARROW_U: 640, // §2.1.6
    DENSE_MIN_GAP_PX: 20, // §2.1.7
    // §2.2 vertical layout of one guitar line (block total 148 px)
    LABEL_ROW: 20,
    STRING_GAP: 18,
    STRING_COUNT: 6,
    RHYTHM_ROW: 16,
    GUITAR_STRING1_Y: 21, // 1 px below the 20 px label row so ticks stay inside it
    GUITAR_SVG_HEIGHT: 128, // 20 label + 90 strings + 16 rhythm + 2 px glyph clearance
    GUITAR_LINE_GAP: 20, // 128 + 20 = 148 px block (§2.2 total)
    STRING_LABEL_X: 30, // §2.2 right-aligned to gutter - 14
    // §2.3 events
    ONSET_CLUSTER_SECONDS: 0.065, // §2.3.3 (= guitarEngine.js ONSET_CLUSTER_SECONDS)
    STEM_HEIGHT: 10, // §2.3.5
    STEM_WIDTH: 1.5,
    // §2.4 glyphs
    FRET_FONT_PX: 13,
    DIGIT_WIDTH_PX: 8, // estimate for 13 px / 600 / tabular digits (no DOM to measure)
    BEND_WIDTH_PX: 7, // estimate for the 12 px "b"
    KNOCKOUT_PAD_X: 4, // §2.4.2 text width + 4
    KNOCKOUT_HEIGHT: 15, // §2.4.2
    MIN_GLYPH_SPACING: 2, // §2.4.4
    MAX_NUDGE_PX: 6, // §2.4.4
    BEND_MIN_SEMITONES: 0.5, // §2.4.3
    // §2.5 sustain
    SUSTAIN_MIN_SECONDS: 0.40,
    TIME_EPSILON: 1e-6, // float slack for >= comparisons on seconds (3.6 - 3.2 < 0.4 in IEEE 754)
    SUSTAIN_CLIP_PX: 2,
    SUSTAIN_MIN_PX: 12,
    // §2.6 / §2.9 confidence
    GUITAR_LOW_CONFIDENCE: 0.48,
    FLUTE_LOW_CONFIDENCE: 0.30, // Q5 default
    // §2.7 marks
    BEAT_TICK_H: 5,
    HALF_TICK_H: 3,
    SECOND_TICK_H: 5,
    TIME_LABEL_EVERY_SECONDS: 2,
    // §2.8 active notes
    ACTIVE_MIN_SECONDS: 0.15,
    // §2.9 flute
    FLUTE_STEP_PX: 6, // 12 px between staff lines
    FLUTE_HEAD_RX: 6,
    FLUTE_HEAD_RY: 4.5,
    FLUTE_HEAD_ROTATE: -18,
    FLUTE_SHARP_OFFSET: 12,
    FLUTE_SHARP_WIDTH: 8,
    FLUTE_LEDGER_WIDTH: 16,
    FLUTE_TOP_MARGIN: 2,
    FLUTE_LINE_GAP: 22,
  });

  const GUITAR_STRING_NAMES = ['e', 'B', 'G', 'D', 'A', 'E']; // §2.2 guitarEnginePhase2d.js STRINGS order

  // §2.9 pitch class -> natural index (C=0 … B=6) and sharp flag
  const PITCH_CLASS_STEPS = [
    [0, false], [0, true], [1, false], [1, true], [2, false], [3, false],
    [3, true], [4, false], [4, true], [5, false], [5, true], [6, false],
  ];

  // §1 engine short labels (prefix match, first wins)
  const ENGINE_LABELS = [
    ['guitar-ear-v0.2e', 'Guitar Ear 0.2e'],
    ['guitar-ear-v0.2d', 'Guitar Ear 0.2d'],
    ['guitar-basic-pitch', 'Basic Pitch (fallback)'],
    ['flute-basic-pitch', 'Basic Pitch (flute)'],
  ];

  const MESSAGES = Object.freeze({
    noResult: 'No transcription yet. Open a YouTube video and click the extension button.',
    loadError: 'Could not load the result: {message}',
    noNotes: 'No notes were detected in this capture.',
  });

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const num = v => (typeof v === 'number' ? v : Number(v));
  const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(num(v));

  /** m:ss (floored seconds). */
  function formatClock(seconds) {
    const s = Math.max(0, Math.floor(num(seconds) + 1e-6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** m:ss.d…  with `decimals` digits (tooltip 2, cursor read 1). */
  function formatPrecise(seconds, decimals = 2) {
    const factor = Math.pow(10, decimals);
    const total = Math.max(0, Math.round(num(seconds) * factor) / factor);
    const m = Math.floor(total / 60);
    const rest = (total - m * 60).toFixed(decimals);
    const [whole, frac] = rest.split('.');
    return `${m}:${whole.padStart(2, '0')}${decimals > 0 ? `.${frac}` : ''}`;
  }

  function engineShortLabel(engine) {
    const raw = String(engine || '');
    for (const [prefix, label] of ENGINE_LABELS) if (raw.startsWith(prefix)) return label;
    return raw; // §1 "other: the raw engine string"
  }

  /** §2.1.2 W from the viewport width (fallback; the renderer measures the real card). */
  function contentWidthForViewport(viewportWidth) {
    return Math.min(num(viewportWidth) - C.PAGE_SIDE_PADDING_TOTAL, C.PAGE_MAX) - C.CARD_PADDING_TOTAL;
  }

  /** F5: tempo is known exactly when the engine used it. */
  function tempoKnown(result) {
    const tempo = result?.summary?.tempo;
    return !!(tempo
      && tempo.available === true
      && num(tempo.confidence) >= 0.25
      && Array.isArray(tempo.beatTimes)
      && tempo.beatTimes.length >= 2);
  }

  /** §2.6 (guitar) / §2.9 (flute) low confidence. */
  function isLowConfidence(note, instrument) {
    const confidence = isNum(note?.confidence) ? num(note.confidence) : 0;
    if (instrument === 'flute') return confidence < C.FLUTE_LOW_CONFIDENCE;
    return confidence < C.GUITAR_LOW_CONFIDENCE || note?.guitarEarSupport === 'uncertain-presence';
  }

  /** §2.8 active window: start <= t < max(end, start + 0.15). */
  function activeEnd(note) {
    const start = num(note.start);
    const end = isNum(note.end) ? num(note.end) : start;
    return Math.max(end, start + C.ACTIVE_MIN_SECONDS);
  }
  function isActiveAt(note, t) {
    return isNum(t) && num(note.start) <= t && t < activeEnd(note);
  }

  /** §2.9 midi -> { step, natural, sharp }. step 0 = E4 (bottom staff line). */
  function fluteStep(midi) {
    const m = Math.round(num(midi));
    const pc = ((m % 12) + 12) % 12;
    const octave = Math.floor(m / 12) - 1;
    const [naturalIndex, sharp] = PITCH_CLASS_STEPS[pc];
    return { step: octave * 7 + naturalIndex - (4 * 7 + 2), naturalIndex, sharp };
  }

  function median(values) {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** §2.1.1 time -> x on a line. */
  function timeToX(line, t, layoutLike) {
    const gutter = layoutLike?.gutter ?? C.GUTTER;
    const U = layoutLike?.unitWidth ?? line.unitWidth;
    return gutter + ((t - line.start) / (line.scaleEnd - line.start)) * U;
  }

  /** Inverse of §2.1.1, clamped to the drawn part of the line. Hook for UX-04 click/drag. */
  function xToTime(line, x, layoutLike) {
    const gutter = layoutLike?.gutter ?? C.GUTTER;
    const U = layoutLike?.unitWidth ?? line.unitWidth;
    const t = line.start + ((x - gutter) / U) * (line.scaleEnd - line.start);
    return Math.max(line.start, Math.min(line.end, t));
  }

  // ---------------------------------------------------------------------------
  // Header (§1)
  // ---------------------------------------------------------------------------

  function youtubeLink(benchmark) {
    if (!benchmark?.videoUrl) return null;
    const start = Math.max(0, Math.floor(num(benchmark.startSeconds) || 0));
    try {
      const url = new URL(benchmark.videoUrl);
      url.searchParams.set('t', `${start}s`);
      return url.toString();
    } catch {
      return `${benchmark.videoUrl}${String(benchmark.videoUrl).includes('?') ? '&' : '?'}t=${start}s`;
    }
  }

  /**
   * §1 header + notice. Returns { title, meta: [{kind, text, href?, title?}], notice }.
   * kind: 'link' | 'section' | 'duration' | 'bpm' | 'engine'.
   */
  function buildHeader(result) {
    if (!result) return { title: 'Music Note Chart', meta: [], notice: null };
    const meta = [];
    const benchmark = result.benchmark || null;
    const href = youtubeLink(benchmark);
    if (href) meta.push({ kind: 'link', text: 'YouTube ↗', href });
    if (benchmark && isNum(benchmark.startSeconds) && isNum(benchmark.endSeconds)) {
      meta.push({ kind: 'section', text: `${formatClock(benchmark.startSeconds)}–${formatClock(benchmark.endSeconds)}` });
    }
    if (isNum(result.duration_seconds)) meta.push({ kind: 'duration', text: `${num(result.duration_seconds).toFixed(1)} s` });
    if (tempoKnown(result) && isNum(result.summary.tempo.bpm)) {
      meta.push({ kind: 'bpm', text: `${Math.round(num(result.summary.tempo.bpm))} BPM` });
    }
    if (result.engine) meta.push({ kind: 'engine', text: engineShortLabel(result.engine), title: String(result.engine) });
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean).map(String) : [];
    // §1 row 2: warnings[1..] only; warnings[0] goes in the legend (§2.6)
    const notice = warnings.length > 1 ? warnings.slice(1).join(' ') : null;
    return { title: result.title || 'Music Note Chart', meta, notice };
  }

  // ---------------------------------------------------------------------------
  // Events (§2.3)
  // ---------------------------------------------------------------------------

  function cleanNotes(result, instrument) {
    const notes = Array.isArray(result?.notes) ? result.notes : [];
    return notes
      .map((note, sourceIndex) => ({ note, sourceIndex }))
      .filter(({ note }) => note && isNum(note.start)
        && (instrument === 'flute' ? isNum(note.midi) : note.guitar && isNum(note.guitar.string) && isNum(note.guitar.fret)))
      .sort((a, b) => num(a.note.start) - num(b.note.start) || a.sourceIndex - b.sourceIndex);
  }

  /** §2.3.2 group by chordId; §2.3.3 65 ms clustering when chordId is missing. */
  function groupEvents(items) {
    const byChord = new Map();
    const groups = [];
    let open = null; // current 65 ms cluster for notes without chordId
    for (const item of items) {
      const chordId = item.note.chordId;
      if (isNum(chordId)) {
        const key = num(chordId);
        let group = byChord.get(key);
        if (!group) { group = { items: [] }; byChord.set(key, group); groups.push(group); }
        group.items.push(item);
        continue;
      }
      const start = num(item.note.start);
      if (open && start - open.anchor <= C.ONSET_CLUSTER_SECONDS) open.items.push(item);
      else { open = { anchor: start, items: [item] }; groups.push(open); }
    }
    return groups
      .map(g => ({ t: Math.min(...g.items.map(i => num(i.note.start))), items: g.items })) // §2.3.2 x = min(start)
      .sort((a, b) => a.t - b.t);
  }

  // ---------------------------------------------------------------------------
  // Lines (§2.1)
  // ---------------------------------------------------------------------------

  function quarterGrid(result) {
    const tempo = result.summary.tempo;
    const beats = tempo.beatTimes.map(num).filter(Number.isFinite);
    const doublePulse = tempo.metricalMode === 'double-pulse';
    // §2.1.3 Q[] = beatTimes (base-pulse) or every second entry (double-pulse, F3)
    const Q = doublePulse ? beats.filter((_, i) => i % 2 === 0) : beats.slice();
    let period = Q.length >= 2 ? median(Q.slice(1).map((t, i) => t - Q[i])) : NaN;
    if (!(period > 0) && beats.length >= 2) period = (beats[1] - beats[0]) * (doublePulse ? 2 : 1);
    if (!(period > 0) && isNum(tempo.bpm)) period = 60 / num(tempo.bpm);
    const bpm = isNum(tempo.bpm) ? num(tempo.bpm) : 60 / period;
    const halfBeats = doublePulse ? beats.filter((_, i) => i % 2 === 1) : [];
    // q(i): Q[i], extrapolated past the end of beatTimes so the last line has a scale end
    const q = i => (i < Q.length ? Q[i] : Q[Q.length - 1] + (i - (Q.length - 1)) * period);
    return { Q, q, period, bpm, doublePulse, halfBeats };
  }

  /** §2.1.3 bars per line from the beat tempo. */
  function barsPerLineFor(bpm) {
    if (bpm < 80) return 2;
    if (bpm > 160) return 8;
    return 4;
  }

  /**
   * Line frames before the dense split. Each frame: { start, scaleEnd, end, qStart, qEnd, pickup }.
   * qStart/qEnd are quarter indexes (tempo only).
   */
  function buildFrames(totalEnd, U, grid) {
    const frames = [];
    const narrow = U < C.NARROW_U; // §2.1.6
    if (!grid) {
      // §2.1.4 no tempo: 8 s per line (§2.1.6: 4 s when narrow)
      const span = narrow ? C.NO_TEMPO_LINE_SECONDS / 2 : C.NO_TEMPO_LINE_SECONDS;
      for (let k = 0; k * span < totalEnd - 1e-9; k++) {
        const start = k * span;
        frames.push({ start, scaleEnd: start + span, end: Math.min(start + span, totalEnd), qStart: null, qEnd: null, pickup: false });
      }
      return { frames, span, barsPerLine: null, beatsPerLine: null };
    }
    const fullBars = barsPerLineFor(grid.bpm);
    const bars = narrow ? fullBars / 2 : fullBars; // §2.1.6 B/2
    const beatsPerLine = bars * C.BEATS_PER_BAR;
    const pickup = grid.Q[0] > C.PICKUP_MIN_SECONDS; // §2.1.3 pickup [0, Q[0])
    for (let k = 0; ; k++) {
      const qStart = k * beatsPerLine;
      const qEnd = qStart + beatsPerLine;
      // §2.1.3 line 1 also includes the pickup
      const start = k === 0 ? (pickup ? 0 : grid.q(0)) : grid.q(qStart);
      if (k > 0 && start >= totalEnd - 1e-9) break;
      const scaleEnd = grid.q(qEnd);
      frames.push({ start, scaleEnd, end: Math.min(scaleEnd, totalEnd), qStart, qEnd, pickup: k === 0 && pickup });
      if (scaleEnd >= totalEnd) break;
    }
    return { frames, span: beatsPerLine * grid.period, barsPerLine: bars, beatsPerLine };
  }

  /** §2.1.7 split a frame into two halves (half the bars, or half the seconds). */
  function splitFrame(frame, grid, totalEnd) {
    let mid;
    let qMid = null;
    if (grid) {
      qMid = frame.qStart + Math.floor((frame.qEnd - frame.qStart) / 2);
      mid = grid.q(qMid);
    } else {
      mid = frame.start + (frame.scaleEnd - frame.start) / 2;
    }
    const first = { ...frame, scaleEnd: mid, end: Math.min(mid, totalEnd), qEnd: qMid, split: 1 };
    if (mid >= totalEnd - 1e-9) return [first];
    const second = { ...frame, start: mid, scaleEnd: frame.scaleEnd, end: Math.min(frame.scaleEnd, totalEnd), qStart: qMid, pickup: false, split: 2 };
    return [first, second];
  }

  // ---------------------------------------------------------------------------
  // Glyph placement (§2.4) and sustain (§2.5)
  // ---------------------------------------------------------------------------

  function guitarGlyphWidth(fret, bend) {
    return String(fret).length * C.DIGIT_WIDTH_PX + (bend ? C.BEND_WIDTH_PX : 0);
  }

  /** Builds the drawable notes of one event at x (no nudge yet). */
  function eventNotes(event, ctx) {
    const { instrument, offset } = ctx;
    const items = [...event.items].sort((a, b) => instrument === 'flute'
      ? num(b.note.midi) - num(a.note.midi)
      : num(a.note.guitar.string) - num(b.note.guitar.string) || num(b.note.confidence || 0) - num(a.note.confidence || 0));
    return items.map(({ note, sourceIndex }) => {
      const start = num(note.start);
      const end = isNum(note.end) ? num(note.end) : start;
      const low = isLowConfidence(note, instrument); // §2.6 / §2.9
      const base = {
        sourceIndex, start, end, activeEnd: activeEnd(note), low,
        midi: isNum(note.midi) ? num(note.midi) : null,
        name: note.name || '',
        confidence: isNum(note.confidence) ? num(note.confidence) : null,
        tooltip: '',
      };
      if (instrument === 'flute') {
        const { step, sharp } = fluteStep(note.midi);
        const leftExtent = sharp ? C.FLUTE_SHARP_OFFSET + C.FLUTE_SHARP_WIDTH / 2 : C.FLUTE_HEAD_RX;
        Object.assign(base, { row: step, step, sharp, text: '', leftExtent, rightExtent: C.FLUTE_HEAD_RX });
      } else {
        const string = Math.round(num(note.guitar.string));
        const fret = Math.round(num(note.guitar.fret));
        const bend = isNum(note.bendSemitones) && num(note.bendSemitones) >= C.BEND_MIN_SEMITONES; // §2.4.3
        const digitsW = String(fret).length * C.DIGIT_WIDTH_PX;
        Object.assign(base, {
          row: string - 1, // §2.2 rowIndex = string - 1 (string 1 on top)
          string, fret, bend,
          bendSemitones: isNum(note.bendSemitones) ? num(note.bendSemitones) : null,
          text: `${fret}${bend ? 'b' : ''}`,
          digitsWidth: digitsW,
          width: guitarGlyphWidth(fret, bend),
          leftExtent: digitsW / 2, // §2.4.1 the number is centred on x; the "b" hangs right
          rightExtent: digitsW / 2 + (bend ? C.BEND_WIDTH_PX : 0),
        });
      }
      // §2.8 tooltip line
      const parts = [note.name || (base.midi !== null ? `MIDI ${base.midi}` : '?')];
      if (instrument !== 'flute') parts.push(`string ${base.string} fret ${base.fret}`);
      parts.push(formatPrecise(start + offset, 2));
      parts.push(`held ${Math.max(0, end - start).toFixed(2)} s`);
      if (base.confidence !== null) parts.push(`${Math.round(base.confidence * 100)} %`);
      if (base.bend) parts.push(`bend ${base.bendSemitones.toFixed(1)} st`); // §2.4.3 tooltip shows the value
      if (note.musicalRole) parts.push(`role ${note.musicalRole}`);
      if (note.guitarEarSupport) parts.push(`support ${note.guitarEarSupport}`);
      base.tooltip = parts.join(' · ');
      return base;
    });
  }

  /** §2.1.7 smallest gap between neighbouring event columns that share a row. */
  function minSharedRowGap(eventsWithX, instrument) {
    const rows = new Map();
    for (const ev of eventsWithX) {
      // flute is one melodic voice: every column shares the staff
      const keys = instrument === 'flute' ? ['staff'] : [...new Set(ev.items.map(i => Math.round(num(i.note.guitar.string))))];
      for (const key of keys) {
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(ev.x);
      }
    }
    let min = Infinity;
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) min = Math.min(min, xs[i] - xs[i - 1]);
    }
    return min;
  }

  /** §2.4.4 nudge glyphs left-to-right on each row (§2.3.4: higher confidence first at equal x). */
  function placeGlyphs(events) {
    const rows = new Map();
    for (const ev of events) for (const n of ev.notes) {
      if (!rows.has(n.row)) rows.set(n.row, []);
      rows.get(n.row).push(n);
    }
    for (const list of rows.values()) {
      list.sort((a, b) => a.baseX - b.baseX || (b.confidence ?? 0) - (a.confidence ?? 0));
      let prevRight = -Infinity;
      for (const n of list) {
        const left = n.baseX - n.leftExtent;
        const overlap = prevRight + C.MIN_GLYPH_SPACING - left;
        n.nudge = overlap > 0 ? Math.min(overlap, C.MAX_NUDGE_PX) : 0; // capped at +6 px, drawn on top if more is needed
        n.x = n.baseX + n.nudge;
        n.left = n.x - n.leftExtent;
        n.right = n.x + n.rightExtent;
        prevRight = n.right;
      }
    }
    return rows;
  }

  /** Left edge of the next glyph to the right of `note` in rowList (later column, or a nudged duplicate). */
  function nextGlyphLeft(rowList, note) {
    let best = Infinity;
    for (const other of rowList) {
      if (other === note) continue;
      const later = other.baseX > note.baseX + 1e-9
        || (Math.abs(other.baseX - note.baseX) <= 1e-9 && other.row === note.row && other.left > note.left);
      if (later) best = Math.min(best, other.left);
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Marks (§2.7)
  // ---------------------------------------------------------------------------

  function tempoMarks(line, grid, offset, xOf) {
    const bars = [];
    const beatTicks = [];
    const topLabels = [];
    const firstQ = line.qStart;
    const lastQ = line.qEnd; // exclusive
    let firstBarLabelDone = false;
    for (let i = firstQ; i < lastQ; i++) {
      const t = grid.q(i);
      if (t < line.start - 1e-9 || t >= line.end - 1e-9) continue;
      const x = xOf(t);
      beatTicks.push({ x, h: C.BEAT_TICK_H, kind: 'beat', t }); // §2.7 beat tick at every Q
      if (i % C.BEATS_PER_BAR === 0) {
        const bar = i / C.BEATS_PER_BAR + 1;
        bars.push({ x, bar, t }); // §2.7 bar line at every 4th Q
        // §2.7 bar number right of the bar line; "Bar n · m:ss" at the start of each line
        const text = firstBarLabelDone ? String(bar) : `Bar ${bar} · ${formatClock(t + offset)}`;
        topLabels.push({ x: x + 3, text, anchor: 'start', kind: firstBarLabelDone ? 'bar' : 'lineStart' });
        firstBarLabelDone = true;
      }
    }
    // a split second half can start mid-bar: then "Bar n · m:ss" goes at the gutter instead
    const startsOnBar = bars.length > 0 && Math.abs(bars[0].t - line.start) < 1e-6;
    if (!line.pickup && !startsOnBar) {
      const bar = Math.floor(firstQ / C.BEATS_PER_BAR) + 1;
      topLabels.unshift({ x: xOf(line.start) + 3, text: `Bar ${bar} · ${formatClock(line.start + offset)}`, anchor: 'start', kind: 'lineStart' });
      if (topLabels[1] && topLabels[1].kind === 'lineStart') {
        topLabels[1].text = String(bars[0].bar);
        topLabels[1].kind = 'bar';
      }
    }
    for (const t of grid.halfBeats) {
      if (t < line.start - 1e-9 || t >= line.end - 1e-9) continue;
      beatTicks.push({ x: xOf(t), h: C.HALF_TICK_H, kind: 'half', t }); // §2.7 half-beat tick
    }
    beatTicks.sort((a, b) => a.x - b.x);
    return { bars, beatTicks, topLabels };
  }

  function secondMarks(line, offset, xOf) {
    const beatTicks = [];
    const topLabels = [];
    for (let s = Math.ceil(line.start - 1e-9); s < line.end - 1e-9; s++) {
      const x = xOf(s);
      beatTicks.push({ x, h: C.SECOND_TICK_H, kind: 'second', t: s }); // §2.7 second tick
      if (s % C.TIME_LABEL_EVERY_SECONDS === 0) topLabels.push({ x, text: formatClock(s + offset), anchor: 'middle', kind: 'time' }); // §2.7 m:ss every 2 s
    }
    return { bars: [], beatTicks, topLabels };
  }

  // ---------------------------------------------------------------------------
  // Vertical geometry
  // ---------------------------------------------------------------------------

  function guitarGeometry() {
    const stringYs = Array.from({ length: C.STRING_COUNT }, (_, i) => C.GUITAR_STRING1_Y + i * C.STRING_GAP);
    const staffTop = stringYs[0];
    const staffBottom = stringYs[stringYs.length - 1];
    const rhythmY2 = staffBottom + C.RHYTHM_ROW + 1;
    return {
      rowY: row => stringYs[row],
      staffLines: stringYs.map((y, i) => ({ y, label: GUITAR_STRING_NAMES[i] })),
      staffTop, staffBottom,
      tickBaseY: staffTop, // §2.7 ticks rise from string 1
      barY1: staffTop, barY2: staffBottom, // §2.7 full staff height
      rhythmY1: rhythmY2 - C.STEM_HEIGHT, rhythmY2, // §2.3.5 10 px stem in the rhythm row
      height: C.GUITAR_SVG_HEIGHT,
      lineGap: C.GUITAR_LINE_GAP,
      ledgers: () => [],
    };
  }

  function fluteGeometry(steps) {
    // §2.9 one vertical extent for every line: min/max step of the whole result ± 1 step, staff always included
    const topStep = Math.max(8, ...steps) + 1;
    const bottomStep = Math.min(0, ...steps) - 1;
    const yTop = C.LABEL_ROW + C.FLUTE_TOP_MARGIN;
    const rowY = step => yTop + (topStep - step) * C.FLUTE_STEP_PX;
    const staffLines = [8, 6, 4, 2, 0].map(step => ({ y: rowY(step), step, label: '' })); // bottom line = E4
    const extentBottom = rowY(bottomStep);
    const rhythmY2 = extentBottom + C.RHYTHM_ROW - 2;
    return {
      rowY,
      staffLines,
      staffTop: rowY(8), staffBottom: rowY(0),
      tickBaseY: rowY(topStep),
      barY1: rowY(8), barY2: rowY(0),
      rhythmY1: rhythmY2 - C.STEM_HEIGHT, rhythmY2,
      height: extentBottom + C.RHYTHM_ROW,
      lineGap: C.FLUTE_LINE_GAP,
      topStep, bottomStep,
      // §2.9 ledger lines for steps above 8 or below 0 (on the even steps up/down to the note)
      ledgers: step => {
        const out = [];
        for (let s = 10; s <= step; s += 2) out.push(rowY(s));
        for (let s = -2; s >= step; s -= 2) out.push(rowY(s));
        return out;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  /**
   * layoutTab(result, contentWidth) -> layout
   *
   * contentWidth = W, the TAB card content width in px (§2.1.2). The renderer measures it.
   *
   * layout = {
   *   kind: 'guitar' | 'flute' | 'empty',
   *   reason?: 'no-result' | 'no-notes',  message?: string        // kind 'empty' only (§1)
   *   header: { title, meta: [{kind, text, href?, title?}], notice }  // §1
   *   title: 'TAB' | 'Melody',                                    // §1 row 4 h2
   *   legend: { items: [{kind:'normal'|'low'|'held'|'meter'|'warning', sample, text}], text }  // §2.6
   *   width: W, gutter, unitWidth: U, rightPad,
   *   offset: seconds added to capture time for labels (benchmark.startSeconds, §2.7 / Q2),
   *   tempo: null | { bpm, period, barsPerLine, doublePulse, quarterTimes },
   *   geometry: { staffLines:[{y,label,step?}], staffTop, staffBottom, tickBaseY, barY1, barY2,
   *               rhythmY1, rhythmY2, height (svg px), lineGap, stringLabelX, topLabelY, topStep?, bottomStep? },
   *   lines: [{
   *     index, start, end, scaleEnd, endX, pxPerSecond, split: 0|1|2, pickup: bool,
   *     firstBar?, lastBar?, noteCount, label (aria, §2.10),
   *     topLabels: [{x, text, anchor:'start'|'middle', kind}],
   *     bars: [{x, bar, t}], beatTicks: [{x, h, kind:'beat'|'half'|'second', t}],
   *     events: [{
   *       index (global, cursor order), lineIndex, t (capture s, = data-t), x (time x, stem),
   *       colLeft, colRight, stemLow, allLow, speech (§7.2 live read), tooltip: [string],
   *       notes: [{ row, y, x (after nudge), baseX, nudge, left, right, text,
   *                 string?, fret?, bend?, digitsWidth?, width?,            // guitar
   *                 step?, sharp?, ledgers?: [y],                             // flute
   *                 low, start, end, activeEnd, midi, name, confidence, sourceIndex, tooltip,
   *                 sustainX1, sustainX2 | null }]                           // §2.5 on this line
   *     }],
   *     carrySustains: [{ y, x1, x2, low, sourceIndex }]  // §2.5 continuation from the gutter
   *   }],
   *   eventCount, noteCount,
   * }
   */
  function layoutTab(result, contentWidth) {
    const header = buildHeader(result);
    const W = Math.max(200, Math.floor(isNum(contentWidth) ? num(contentWidth) : 1000));
    const U = W - C.U_INSET; // §2.1.2 U = W - 56
    const base = { header, width: W, gutter: C.GUTTER, rightPad: C.RIGHT_PAD, unitWidth: U };
    if (!result) return { ...base, kind: 'empty', reason: 'no-result', message: MESSAGES.noResult, title: 'TAB', lines: [], eventCount: 0, noteCount: 0 };

    const instrument = result.instrument === 'flute' ? 'flute' : 'guitar';
    const title = instrument === 'flute' ? 'Melody' : 'TAB';
    const items = cleanNotes(result, instrument);
    if (!items.length) return { ...base, kind: 'empty', reason: 'no-notes', message: MESSAGES.noNotes, title, lines: [], eventCount: 0, noteCount: 0 };

    const offset = result.benchmark && isNum(result.benchmark.startSeconds) ? num(result.benchmark.startSeconds) : 0; // §2.7 video time
    let grid = instrument === 'guitar' && tempoKnown(result) ? quarterGrid(result) : null; // §2.9 flute: no tempo
    if (grid && !(grid.period > 0 && Number.isFinite(grid.bpm) && grid.Q.length)) grid = null;
    const lastNoteEnd = Math.max(...items.map(({ note }) => Math.max(num(note.start), isNum(note.end) ? num(note.end) : 0)));
    const lastStart = Math.max(...items.map(({ note }) => num(note.start)));
    // §2.1.5 the last line ends at duration_seconds (kept ≥ the last onset so no event is lost)
    // (a sustain past the end never adds a line; an onset at/after the end is clamped into the last line)
    const totalEnd = isNum(result.duration_seconds) && num(result.duration_seconds) > 0
      ? num(result.duration_seconds)
      : Math.max(lastStart + 0.01, lastNoteEnd);

    const groups = groupEvents(items);
    const geometry = instrument === 'flute'
      ? fluteGeometry(items.map(({ note }) => fluteStep(note.midi).step))
      : guitarGeometry();
    const ctx = { instrument, offset };

    const { frames, barsPerLine } = buildFrames(totalEnd, U, grid);

    // assign events to frames: [start, end); events before line 1 or after the end are clamped in
    const eventsInFrame = (frame, isFirst, isLast) => groups.filter(g =>
      (g.t >= frame.start - 1e-9 || isFirst) && (g.t < frame.end - 1e-9 || isLast));

    const lineFrames = [];
    frames.forEach((frame, fi) => {
      const isFirst = fi === 0;
      const isLast = fi === frames.length - 1;
      const xOf = t => C.GUTTER + ((t - frame.start) / (frame.scaleEnd - frame.start)) * U;
      const evs = eventsInFrame(frame, isFirst, isLast).map(g => ({ ...g, x: xOf(Math.max(frame.start, g.t)) }));
      // §2.1.7 dense line: split once if two neighbouring columns on one string are < 20 px apart
      if (minSharedRowGap(evs, instrument) < C.DENSE_MIN_GAP_PX) {
        const halves = splitFrame(frame, grid, totalEnd);
        halves.forEach((h, hi) => lineFrames.push({ frame: h, isFirst: isFirst && hi === 0, isLast: isLast && hi === halves.length - 1 }));
      } else {
        lineFrames.push({ frame: { ...frame, split: 0 }, isFirst, isLast });
      }
    });

    let eventIndex = 0;
    let noteTotal = 0;
    const lines = lineFrames.map(({ frame, isFirst, isLast }, lineIndex) => {
      const line = {
        index: lineIndex,
        start: frame.start, end: frame.end, scaleEnd: frame.scaleEnd,
        split: frame.split || 0, pickup: !!frame.pickup,
        qStart: frame.qStart, qEnd: frame.qEnd,
        unitWidth: U,
      };
      line.pxPerSecond = U / (line.scaleEnd - line.start);
      const xOf = t => C.GUTTER + (t - line.start) * line.pxPerSecond; // §2.1.1
      line.endX = xOf(line.end); // §2.1.5 the last line is not stretched
      const groupsHere = eventsInFrame(frame, isFirst, isLast);
      line.events = groupsHere.map(g => {
        const x = xOf(Math.max(line.start, Math.min(line.end, g.t)));
        const ev = { index: eventIndex++, lineIndex, t: g.t, x, items: g.items };
        ev.notes = eventNotes(ev, ctx).map(n => ({ ...n, baseX: x, y: geometry.rowY(n.row) }));
        if (instrument === 'flute') ev.notes.forEach(n => { n.ledgers = geometry.ledgers(n.step); });
        return ev;
      });
      const rows = placeGlyphs(line.events);

      // §2.5 sustain on this line, clipped 2 px before the next glyph on the same row and at the line end
      const flatAll = instrument === 'flute' ? line.events.flatMap(e => e.notes) : null;
      for (const ev of line.events) for (const n of ev.notes) {
        n.sustainX1 = null;
        n.sustainX2 = null;
        n.sustainClipped = false;
        if (n.end - n.start < C.SUSTAIN_MIN_SECONDS - C.TIME_EPSILON) continue;
        const rowList = instrument === 'flute' ? flatAll : rows.get(n.row); // flute: one melodic voice
        const nextLeft = nextGlyphLeft(rowList, n);
        const x1 = n.right;
        let x2 = Math.min(xOf(n.end), line.endX);
        if (nextLeft - C.SUSTAIN_CLIP_PX < x2) { x2 = nextLeft - C.SUSTAIN_CLIP_PX; n.sustainClipped = true; }
        if (x2 - x1 >= C.SUSTAIN_MIN_PX) { n.sustainX1 = x1; n.sustainX2 = x2; }
      }

      // event decorations
      for (const ev of line.events) {
        ev.allLow = ev.notes.every(n => n.low);
        ev.stemLow = ev.allLow; // §2.3.5 --tab-low if every note is low
        ev.colLeft = Math.min(ev.x - 4, ...ev.notes.map(n => n.left));
        ev.colRight = Math.max(ev.x + 4, ...ev.notes.map(n => n.right));
        ev.tooltip = ev.notes.map(n => n.tooltip);
        ev.speech = speechFor(ev, instrument, offset); // §7.2 live read
        delete ev.items;
      }

      const marks = grid ? tempoMarks(line, grid, offset, xOf) : secondMarks(line, offset, xOf);
      Object.assign(line, marks);
      line.noteCount = line.events.reduce((s, e) => s + e.notes.length, 0);
      noteTotal += line.noteCount;
      if (grid) {
        line.firstBar = line.pickup ? 1 : Math.floor(line.qStart / C.BEATS_PER_BAR) + 1;
        let lastQi = line.qStart;
        for (let i = line.qStart; i < line.qEnd; i++) if (grid.q(i) < line.end - 1e-9) lastQi = i;
        line.lastBar = Math.floor(lastQi / C.BEATS_PER_BAR) + 1;
      }
      line.label = lineLabel(line, offset); // §2.10
      line.carrySustains = [];
      return line;
    });

    // §2.5 a sustain that crosses a line break continues from the gutter of the next line
    lines.forEach((line, li) => {
      for (const ev of line.events) for (const n of ev.notes) {
        if (n.end - n.start < C.SUSTAIN_MIN_SECONDS - C.TIME_EPSILON || n.sustainClipped || n.end <= line.end + 1e-9) continue;
        for (let j = li + 1; j < lines.length; j++) {
          const next = lines[j];
          if (n.end <= next.start + 1e-9) break;
          const xOf = t => C.GUTTER + (t - next.start) * next.pxPerSecond;
          const sameRow = next.events.flatMap(e => e.notes).filter(o => instrument === 'flute' || o.row === n.row);
          const firstLeft = sameRow.length ? Math.min(...sameRow.map(o => o.left)) : Infinity;
          let x2 = Math.min(xOf(n.end), next.endX);
          let clipped = false;
          if (firstLeft - C.SUSTAIN_CLIP_PX < x2) { x2 = firstLeft - C.SUSTAIN_CLIP_PX; clipped = true; }
          const x1 = C.GUTTER;
          if (x2 - x1 >= C.SUSTAIN_MIN_PX) next.carrySustains.push({ y: n.y, x1, x2, low: n.low, sourceIndex: n.sourceIndex });
          if (clipped || n.end <= next.end + 1e-9) break;
        }
      }
    });

    const legend = buildLegend(result, instrument, !!grid);
    return {
      ...base,
      kind: instrument,
      title,
      offset,
      legend,
      tempo: grid ? { bpm: grid.bpm, period: grid.period, barsPerLine, doublePulse: grid.doublePulse, quarterTimes: grid.Q.slice() } : null,
      geometry: {
        staffLines: geometry.staffLines,
        staffTop: geometry.staffTop, staffBottom: geometry.staffBottom,
        tickBaseY: geometry.tickBaseY, barY1: geometry.barY1, barY2: geometry.barY2,
        rhythmY1: geometry.rhythmY1, rhythmY2: geometry.rhythmY2,
        height: geometry.height, lineGap: geometry.lineGap,
        stringLabelX: C.STRING_LABEL_X, topLabelY: 13,
        topStep: geometry.topStep, bottomStep: geometry.bottomStep,
      },
      lines,
      eventCount: eventIndex,
      noteCount: noteTotal,
    };
  }

  function lineLabel(line, offset) {
    const parts = [`Line ${line.index + 1}`];
    if (line.firstBar) parts.push(line.firstBar === line.lastBar ? `bar ${line.firstBar}` : `bars ${line.firstBar} to ${line.lastBar}`);
    parts.push(`${formatClock(line.start + offset)} to ${formatClock(line.end + offset)}`);
    parts.push(`${line.noteCount} ${line.noteCount === 1 ? 'note' : 'notes'}`);
    return parts.join(', ');
  }

  function speechFor(ev, instrument, offset) {
    const time = formatPrecise(ev.t + offset, 1);
    const described = ev.notes.map(n => {
      const what = instrument === 'flute' ? (n.name || `MIDI ${n.midi}`) : `string ${n.string} fret ${n.fret}`;
      return n.low ? `${what}, low confidence` : what;
    });
    if (ev.notes.length > 1) return `${time}, chord: ${described.join(', ')}`;
    return `${time}, ${described[0]}`;
  }

  function buildLegend(result, instrument, tempoIsKnown) {
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean).map(String) : [];
    const sample = instrument === 'flute' ? '●' : '12';
    const pct = Math.round((instrument === 'flute' ? C.FLUTE_LOW_CONFIDENCE : C.GUITAR_LOW_CONFIDENCE) * 100);
    // §2.6 legend row
    const items = [
      { kind: 'normal', sample, text: '= normal' },
      { kind: 'low', sample, text: `(dotted) = low confidence (< ${pct} %)` },
      { kind: 'held', sample: '─', text: 'held note' },
    ];
    if (tempoIsKnown) items.push({ kind: 'meter', sample: '', text: 'Bars assume 4/4' }); // Q1
    if (warnings[0]) items.push({ kind: 'warning', sample: '', text: warnings[0] });
    const text = items.map(i => (i.sample ? `${i.sample} ${i.text}` : i.text)).join(' · ');
    return { items, text };
  }

  /** §7.2 container label. */
  function tabAriaLabel(layout) {
    const n = layout?.noteCount || 0;
    return `${layout?.title || 'TAB'}, ${n} ${n === 1 ? 'note' : 'notes'}. Use left and right arrows to move between notes.`;
  }

  return {
    CONSTANTS: C,
    MESSAGES,
    GUITAR_STRING_NAMES,
    layoutTab,
    buildHeader,
    engineShortLabel,
    contentWidthForViewport,
    tempoKnown,
    isLowConfidence,
    isActiveAt,
    activeEnd,
    fluteStep,
    formatClock,
    formatPrecise,
    timeToX,
    xToTime,
    tabAriaLabel,
  };
});
