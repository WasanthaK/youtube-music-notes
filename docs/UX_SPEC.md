# UX spec: result page, transport, diagnostics, popup

Status: draft for UX-03 to UX-07. Source of truth for the mockup and the implementation.
Scope: `extension/result.*`, `original-audio.js`, `clean-playback.js`, `critic.js`, `popup.*`, plus the small `service_worker.js` changes in §5.
Words: **must** = required; **should** = default unless the task finds a blocker.

---

## 0. What the data actually contains

All rules below use only these fields. The result object is built by `src/pipeline.js:transcribeAudio` and stored in IndexedDB `youtube-music-notes-extension` / `analysis` / key `latest` by `src/offscreen-phase2d.js:endRecording`.

| Field | Present when | Used for |
|---|---|---|
| `title`, `instrument` (`guitar`/`flute`), `mode`, `engine`, `duration_seconds`, `warnings[]` | always | header, diagnostics |
| `benchmark.{mode, videoId, videoUrl, startSeconds, endSeconds, requestedDurationSeconds}` | segment capture (always, in the current popup) | header link, time labels |
| `captured_audio_blob`, `captured_audio_mime_type`, `captured_audio_size_bytes` | results saved since local audio retention | Original source |
| `midi_base64` | **always `null`** in the browser build (`pipeline.js`) | hide MIDI download |
| `diagnostic.{supabase_status, supabase_error}` | always | diagnostics |
| `notes[].start`, `.end`, `.midi`, `.name`, `.confidence` (0–1) | always | x, sustain, fade, tooltip |
| `notes[].guitar.{string 1–6, stringName, fret 0–24}` | guitar | TAB row and number |
| `notes[].chordId` (integer, shared by one onset cluster) | guitar, both engines | chord stacking |
| `notes[].bendSemitones` | guitar | bend mark |
| `notes[].musicalRole` (`lead` / `double-stop` / `chord`), `.guitarEarSupport` (`attack` / `presence` / `uncertain-presence`), `.rhythmSlot`, `.rhythmSlotTime`, `.rhythmBeatIndex`, `.rhythmSubdivision` | guitar, Guitar Ear engine only (`guitarEnginePhase2d.js`) | fade, tooltip |
| `summary.tempo.{available, bpm, pulseBpm, confidence, metricalMode, beatTimes[], phaseSeconds, pulsePeriodSeconds}` | guitar, Guitar Ear engine only. **Absent** for the fallback engine `guitar-basic-pitch-ensemble-v1.2` and for flute | bars and beats |
| `summary.rhythm.enabled` | Guitar Ear engine only | diagnostics |
| `summary.{playableNotes, highConfidence, uncertain, averageConfidence}` | guitar | diagnostics |

Facts that drive decisions:

- F1. In the Guitar Ear engine, all notes with the same `chordId` have the **same** `start` (`guitarMusicalDecoder.js:applyArticulation` sets `start = anchor`). In the fallback engine, notes with the same `chordId` can differ by up to 65 ms (`guitarEngine.js` `ONSET_CLUSTER_SECONDS = 0.065`).
- F2. Within one `chordId`, each string is used at most once (`solveAssignment` uses `usedStrings`).
- F3. `summary.tempo.beatTimes` are spaced by `pulseBpm`, not `bpm`. When `metricalMode === 'double-pulse'`, each entry is half a beat (`tempoAnalysis.js:chooseTempo`, `makeBeatTimes`). `bpm` is the beat tempo (60–200).
- F4. There is **no downbeat or time signature** in the data.
- F5. Tempo is "known" exactly when the engine used it: `tempo.available === true && tempo.confidence >= 0.25` (same test as `rhythmGrid.js:applyTempoGrid`) and `beatTimes.length >= 2`.
- F6. Confidence bands already used by the engines: high `>= 0.67`, uncertain `< 0.48` (`guitarEnginePhase2d.js` and `guitarEngine.js` `summary.highConfidence` / `summary.uncertain`).
- F7. Non-lead durations are synthetic: `applyArticulation` caps them at 0.38 s. Lead notes can last 0.20–0.85 s.
- F8. Note times are seconds from the start of the captured audio blob, so the TAB and the Original source share one timeline.
- F9. **Mode does nothing in the browser build.** `popup.js` sends `mode`. `service_worker.js` forwards it. `pipeline.js` only copies it to `result.mode`, and `result.js` prints it in `#meta`. No engine reads it. Only `backend/app.py` uses `arrange`/`transcribe`, and the extension never calls the backend.
- F10. The popup always sends `startSeconds: 0, endSeconds: 90, benchmarkMode: 'fixed-90s-v1'` (`popup.js`), and `service_worker.js:prepareYouTubeSegment` seeks the video there. That is why the extension always rewinds.

---

## 1. Result page layout (top to bottom)

Max content width 1200 px, centred, side padding 24 px (16 px under 640 px viewport).

| # | Block | Content | Height |
|---|---|---|---|
| 1 | Header (not sticky) | Line 1: `h1` = `title`. Line 2 (meta, 13 px muted, items joined by " · "): **YouTube ↗** link to `benchmark.videoUrl` with `&t={floor(startSeconds)}s`, opens new tab; section `m:ss–m:ss` from `benchmark.startSeconds`/`endSeconds`; duration `duration_seconds` as `90.0 s`; `{round(bpm)} BPM` only if tempo known (F5); engine short label (table below) with full `engine` in `title` attribute. | ≤ 72 px |
| 2 | Notice (optional) | Shown only if `warnings.length > 1`: `warnings[1..]` joined, one line, 13 px, neutral notice style. `warnings[0]` (always the generic "approximate" text) goes in the TAB legend instead. | 0 or 40 px |
| 3 | Transport | §3. In the DOM it comes **right after the header**. On screen it is fixed to the bottom of the viewport. | 64 px |
| 4 | TAB card | `h2` "TAB" (guitar) or "Melody" (flute) + legend row + the lines (§2). | auto |
| 5 | Diagnostics | `<details>` collapsed (§4). | 48 px closed |
| — | Bottom spacer | 80 px so the fixed transport never covers the last TAB line. | 80 px |

Engine short labels (match by prefix of `engine`):

| Prefix | Label |
|---|---|
| `guitar-ear-v0.2e` | Guitar Ear 0.2e |
| `guitar-ear-v0.2d` | Guitar Ear 0.2d |
| `guitar-basic-pitch` | Basic Pitch (fallback) |
| `flute-basic-pitch` | Basic Pitch (flute) |
| other | the raw `engine` string |

Remove from the visible page: `#originalAudioCard`, `.playbackCard`, `.criticCard`, the notes-table card, the `#downloadMidi`/`#downloadJson` header buttons, and the native `<audio controls>`. They move to the transport (§3) or Diagnostics (§4).

Empty and error states (they replace the TAB card body; the header still shows):
- No result: "No transcription yet. Open a YouTube video and click the extension button."
- Load error: "Could not load the result: {message}".
- `notes.length === 0`: "No notes were detected in this capture." Transport offers Original only.

---

## 2. TAB rendering rules (UX-03)

### 2.1 Time axis and lines

1. x is set by time only. A line covers `[lineStart, lineEnd)`. Within it, `x = gutter + (t − lineStart) / (lineEnd − lineStart) × U`.
2. `W` = TAB card content width = `min(viewport − 48, 1200) − 40`. `gutter` = 44 px (string labels plus clear space, so a fret on a line's first beat never touches its string label). Right pad = 12 px. `U = W − 56`.
3. **Tempo known (F5): lines are made of bars.**
   - Quarter beats `Q[]` = `beatTimes` if `metricalMode === 'base-pulse'`, or every second entry (`beatTimes[0], [2], [4] …`) if `'double-pulse'` (F3).
   - Bars are 4 beats long (4/4 assumed, F4). Bar 1 starts at `Q[0]`. If `Q[0] > 0.05 s`, the stretch `[0, Q[0])` is a pickup on line 1, with no bar number.
   - Bars per line `B`: 4 if `80 ≤ bpm ≤ 160`; 2 if `bpm < 80`; 8 if `bpm > 160`. This keeps one line at 6–12 s, so a 90 s capture is 8–15 lines. Four bars per line is how printed TAB is normally laid out.
   - Line k runs from bar `k·B + 1` to bar `(k+1)·B + 1`. Line 1 also includes the pickup.
4. **No tempo: 8 s per line.** Line k = `[8k, 8k + 8)`. At `U ≈ 1100` that is about 137 px/s. A 90 s capture is 12 lines.
5. The last line keeps the same px-per-second as a full line. It ends at `duration_seconds` and is not stretched.
6. Narrow screens: if `U < 640`, halve the line span (`B/2` bars, or 4 s).
7. Dense lines: before drawing a line, find the smallest gap between neighbouring event columns (§2.3) that share a string. If it is under 20 px, split this line into two halves (half the bars, or half the seconds). Split at most once per line. Any overlap that remains is handled by the nudge rule (§2.4).

### 2.2 Vertical layout of one guitar line

| Part | Size |
|---|---|
| Top label row (bar number / time) | 20 px |
| Strings: 6 lines, 18 px apart, top = string 1 `e` | 90 px |
| Rhythm row below the staff | 16 px |
| Gap to next line | 22 px |
| **Line block total** | **148 px** |

- String labels `e B G D A E` (from `guitar.stringName` order in `guitarEnginePhase2d.js` `STRINGS`) sit at the left of every line, 12 px, muted colour, right-aligned at x = `gutter − 14` (30 px). A glyph on the line's first beat therefore starts at least 4 px right of the label (a two-digit fret's left edge is at `gutter − 8`).
- String lines are 1 px, `--tab-line`.
- Row of a note: `rowIndex = guitar.string − 1` (string 1 on top). This is the inverse of the current `6 − string` mapping, which drew a low E as the top line.

### 2.3 Events and chords

1. An **event** is one x position with one or more notes.
2. Grouping: notes with the same `chordId` form one event. Its x is `min(start)` of the group (F1).
3. If `chordId` is missing (older results), group notes whose `start` lies within 65 ms of the first note in the group (same constant as `ONSET_CLUSTER_SECONDS`).
4. A chord is stacked vertically: each fret number sits on its own string row at the same x. F2 guarantees one note per string per `chordId`. If two notes of an event still share a string (only possible with rule 3), keep the one with the higher `confidence` at x and nudge the other per §2.4.
5. Rhythm row: each event draws a 1.5 px vertical stem 10 px tall in the rhythm row at its x, coloured `--tab-fret` (or `--tab-low` if every note in the event is low confidence). This makes the rhythm visible even when the frets repeat.

### 2.4 Fret numbers and overlap

1. The fret glyph is `guitar.fret` in 13 px, weight 600, tabular numerals, centred on (x, string y).
2. Each glyph has a knockout rect behind it: page-surface colour, text width + 4 px wide, 15 px tall. The string line never crosses the digits.
3. Bend: if `bendSemitones >= 0.5`, add a 12 px "b" right after the number (`7b`). The tooltip shows the value.
4. Overlap on one string: going left to right, if a glyph's left edge is less than 2 px past the previous glyph's right edge, move it right by the overlap, by at most 6 px. If more than 6 px is needed, draw it anyway at +6 px, on top of the previous glyph. Rule 2.1.7 makes this rare. Nudging never changes the event's stem or the time that a click maps to.

### 2.5 Sustain

- Draw a sustain bar when `end − start >= 0.40 s`. F7 means this marks real held notes (lead) and not the synthetic chord decay.
- The bar is 2 px tall on the note's string, from the glyph's right edge to `x(end)`. It is clipped 2 px before the next glyph on the same string and at the line's end. It is not drawn if it would be shorter than 12 px.
- A sustain that crosses a line break continues from the gutter of the next line.
- Colour: same as its glyph.

### 2.6 Confidence

- A note is **low confidence** if `confidence < 0.48` (the engines' `uncertain` band, F6) **or** `guitarEarSupport === 'uncertain-presence'` (kept outside detected guitar regions; `guitarEnginePhase2d.js:applyGuitarEarGate`).
- Low-confidence glyphs use `--tab-low` plus a 1 px dotted underline, 2 px below the digits. The underline means colour is not the only cue, and `--tab-low` still meets 4.5:1.
- Legend row above the TAB, 12 px muted: `12 = normal · 12 (dotted) = low confidence (< 48 %) · ─ held note · Bars assume 4/4` (the last part only when tempo is known) · `warnings[0]`.

### 2.7 Bars, beats, seconds

| Mark | Tempo known | No tempo |
|---|---|---|
| Bar line | At every 4th `Q`: 1.5 px, `--bar`, full staff height (string 1 to string 6) | — |
| Beat tick | At every `Q`: 1 px, 5 px tall, rising from string 1 | Second tick at every whole second: 1 px, 5 px tall, rising from string 1 |
| Half-beat tick | At the odd `beatTimes` when `double-pulse`: 1 px, 3 px tall | — |
| Top label | Bar number (12 px) just right of each bar line. At the start of each line: `Bar n · m:ss` | `m:ss` every 2 s, centred on its tick |
| Line start | First bar line of the line is drawn at the gutter | — |

Time labels are capture time plus `benchmark.startSeconds` (that is, video time) when `benchmark` exists. Otherwise they are capture time. Format: `m:ss`. See Q2.

### 2.8 Interaction on the TAB

- Hover or keyboard focus on an event shows a tooltip (max 280 px, 12 px). One line per note: `E4 · string 1 fret 0 · 0:12.35 · held 0.40 s · 72 %`, plus `role` / `support` when present. This replaces the notes table on the main page.
- Click (pointer moved < 6 px): seek to `x→t` of the click point.
- Drag (≥ 6 px): set a loop (§3.4).
- Active notes during playback (`start ≤ t < max(end, start + 0.15)`): glyph drawn in `--accent` with weight 700 and a 1 px `--accent` box. This replaces the `tr.playing` highlight.

### 2.9 Flute

Flute keeps a staff but uses the same time axis, line spans and marks (§2.1, §2.7). Flute has no tempo, so lines are always 8 s.
- Treble staff: 5 lines, 12 px apart (6 px per diatonic step). Bottom line = E4.
- Vertical step: pitch class → (natural step, sharp?) = `0:C, 1:C♯, 2:D, 3:D♯, 4:E, 5:F, 6:F♯, 7:G, 8:G♯, 9:A, 10:A♯, 11:B`. `step = octave·7 + naturalIndex − (4·7 + 2)`. This replaces `renderFlute`'s nearest-natural search, which drew sharps as the wrong natural with no accidental.
- Note head: filled ellipse rx 6, ry 4.5, rotated −18°. A ♯ in 13 px is drawn 12 px left of the head. No stems (the data has no note values).
- Ledger lines (16 px wide) for steps above 8 or below 0.
- Line height: all lines use the same vertical extent, computed from the min and max step in the whole result (plus 1 step of padding each side), the 20 px top label row, 16 px rhythm row and 22 px gap.
- Sustain: a 2 px bar at head height to `x(end)` when `end − start >= 0.40 s` (flute durations are real).
- Low confidence for flute: `confidence < 0.30`. Flute `confidence` is Basic Pitch amplitude, and `reduceMelody` keeps ≥ 0.18, so 0.30 is just above the floor. See Q5.

### 2.10 Rendering technique

- One `<svg>` per line, `width = W`, no `min-width`. Delete the `svg { min-width: 900px }` rule. Re-layout on resize, debounced to 150 ms.
- Each line is `<svg role="group" aria-label="Line 3, bars 9 to 12, 0:16 to 0:24, 14 notes">`. Each event is `<g>` with a `data-t` attribute (seconds).

---

## 3. Transport (UX-04)

### 3.1 Controls, in order (left to right; DOM order = focus order)

| # | Control | Element | Detail |
|---|---|---|---|
| 1 | Play / Pause | `button`, 40×40, primary | Label toggles "Play" / "Pause" (`aria-label`), icon ▶ / ❚❚ |
| 2 | Stop | `button`, 32×32 | Pause and go back to loop start (or 0:00). Disabled at 0:00 when not playing |
| 3 | Time | `output`, 13 px tabular | `0:12.3 / 1:30.0` (capture time) |
| 4 | Source | radio group of 3 segmented buttons | Original · Transcription · Both |
| 5 | Speed | `input type=range` 0.50–1.00, step 0.05 + text `0.75×` | Default 1.00 |
| 6 | Loop | toggle `button` (`aria-pressed`) + text `0:08.0–0:16.0` + clear `button` "×" | Disabled until a loop exists |

Wraps to 2 rows below 640 px (1–3 on row 1, 4–6 on row 2; height 104 px).

### 3.2 States

| State | Play | Stop | Source / Speed | Status text (aria-live) |
|---|---|---|---|---|
| Loading | disabled | disabled | disabled | "Loading result…" |
| Ready | enabled | disabled | enabled | — |
| Playing | shows Pause | enabled | enabled. A change applies within 100 ms without stopping | "Playing {source} at {rate}×" |
| Paused | shows Play | enabled | enabled | "Paused at m:ss" |
| Ended | shows Play; next Play starts at 0 or loop start | enabled | enabled | "Finished" |

- Original and Both are disabled (with `title` "No captured audio saved for this result.") when `captured_audio_blob` is missing or empty. Default source: **Both** when audio exists, else Transcription (Q3).
- Transcription is disabled when `notes.length === 0`.
- Only one transport exists. It replaces all 14 buttons (`playOriginalTen`, `playOriginalTenSlow`, `stopOriginalAudio`, `playTen`, `playTenSlow`, `playAll`, `stopPlayback`, `openOriginal`, `playCleanTen`, `playLeadTen`, `playBridgedLeadTen`, `stopCleanPlayback`, `playRhythmGuitar`, `playViolinLegato`) and the native `<audio controls>`.

### 3.3 Playhead

- A 2 px vertical line in `--playhead` on the current line, from 6 px above string 1 to the bottom of the rhythm row. It is updated with `requestAnimationFrame`.
- Follow: when the playhead enters a line that is not fully visible above the transport bar, scroll that line to 96 px from the top of the viewport. Use instant scroll if `prefers-reduced-motion: reduce`, else smooth. After a manual wheel, touch or scrollbar scroll, follow pauses for 5 s.

### 3.4 Loop

- Drag on any TAB line (≥ 6 px) to set a loop from the press time to the release time. The drag may cross lines. With tempo known, snap both ends to the nearest `beatTimes` entry. Without tempo, snap to 0.25 s. Minimum length 0.5 s.
- Show the loop as an `--accent` band at 12 % opacity across the staff on each line it covers, with 8 px drag handles at both ends (cursor `ew-resize`).
- Setting a loop turns Loop on. Clicking the Loop toggle turns it off but keeps the range. "×" deletes the range.
- When playback reaches the loop end with Loop on, it jumps to the loop start (§3.6 re-render) with ≤ 30 ms of silence.

### 3.5 Keyboard shortcuts

These are active on `document` unless focus is in `input`, `select` or `textarea`. Space and Enter on a focused button keep their native meaning.

| Key | Action |
|---|---|
| Space or K | Play / Pause |
| ← / → | Seek −2 s / +2 s |
| Shift + ← / → | Seek one bar (tempo known) or 8 s back / forward |
| Home | Go to loop start, or 0:00 |
| 1 / 2 / 3 | Source: Original / Transcription / Both |
| − / = | Speed −0.05 / +0.05 (clamped to 0.50–1.00) |
| A / B | Set loop start / end at the playhead |
| L | Loop on/off |
| Esc | Clear the loop |
| ? | Show a shortcuts dialog (`<dialog>`, closed with Esc) |

Inside the focused TAB (§7) ← and → move between events instead of seeking.

### 3.6 Sync and audio engine

Target: in Both, the transcription stays within **≤ 50 ms** of the original (p95) and never more than 80 ms, over a full 90 s, at 1.0× and at 0.5×.

1. Use one `AudioContext` for everything. Original goes `HTMLAudioElement (blob URL, preservesPitch = true) → createMediaElementSource → gainOriginal → destination`. The synth goes `voice → gainTranscription → compressor → destination`. Both are clocked by the same audio context, so they do not drift.
2. Media time is the master. On play from time `t0` at rate `r`: set `audio.currentTime = t0` and `audio.playbackRate = r`, call `play()`, and wait for `playing`. Then record the pair `(ctxT = ctx.currentTime, mediaT = audio.currentTime)`. Schedule every note in `[mediaT, loopEnd or duration)` at `when = ctxT + (note.start − mediaT) / r`.
3. Every 250 ms, compute `drift = audio.currentTime − (mediaT + (ctx.currentTime − ctxT)·r)`. If `|drift| > 0.030 s`, stop all synth sources and re-schedule from step 2 using the current pair.
4. Transcription only: no media element. Use the ctx clock directly (`mediaT = t0`).
5. Seek, rate change, source change and loop wrap all go: stop the synth sources, then step 2.
6. Acceptance test: add a debug flag (`?synccheck=1`). For each note, log `note.start − audio.currentTime` measured at its scheduled `when`. Report p95 and max to the console for one 90 s Both run at 1.0× and one at 0.5×.

Voices (for the test voices in §4) share one interface:
`render(ctx, destination, notes, fromSec, toSec, rate, ctxStartTime) → AudioScheduledSourceNode[]`.
The guitar voice wraps `result.js:scheduleGuitarNote` / `scheduleFluteNote`. The test voices wrap `clean-playback.js:playClean` (clean / lead / bridged), `playRhythmGuitar` and `playViolinLegato`, with their fixed `startAt + note.start` replaced by `ctxStartTime + (note.start − fromSec) / rate`.

---

## 4. Diagnostics panel (UX-05)

`<details id="diagnostics">`, **closed by default**. Do not save the open/closed state. Summary line: "Diagnostics" + 12 px muted "engine, test playback, AI critic, notes table, downloads". Inside, in this order, each part with an `h3` (14 px):

| # | Part | Content (fields) | Moved from |
|---|---|---|---|
| 1 | Run summary | Key/value list: Engine = `engine` (full); Guitar Ear = `summary.guitarEar.{model, phase, device, available, modelFallbackReason, error}`; Tempo = `summary.tempo.{bpm, pulseBpm, confidence, metricalMode, method}` or "not detected"; Rhythm grid = `summary.rhythm.{enabled, mode}`; Notes = `notes.length`, `summary.{highConfidence, uncertain, averageConfidence}`; Capture = `benchmark.{mode, startSeconds, endSeconds, requestedDurationSeconds}`, `duration_seconds`, `captured_audio_size_bytes`, `captured_audio_mime_type`; Mode = `mode`; Warnings = all `warnings`; Diagnostic upload = `diagnostic.supabase_status` / `supabase_error` | `#meta` line, `#originalAudioMeta` |
| 2 | Test playback | `select` "Transcription voice": Guitar (default), Clean notes, Lead line, Bridged lead, Rhythm guitar, Violin legato. It changes what the transport's Transcription source plays and is reset to Guitar on reload. Below it, the gap check text from `clean-playback.js:showLocalGapSummary` | 7 buttons in `clean-playback.js` |
| 3 | AI critic | Button "Analyse with AI" + note "Sends notes (not audio) to the critic service." + output. Hidden for flute | `.criticCard` |
| 4 | Detected notes | The current table plus columns Chord (`chordId`), Role (`musicalRole`), Support (`guitarEarSupport`). Max height 420 px with scroll. Clicking a row seeks the transport to that note's `start` | notes-table card |
| 5 | Downloads | "Download JSON", "Download captured audio" (if there is a blob), "Download MIDI" (only if `midi_base64` is not null) | header buttons, `#downloadOriginalAudio` |

---

## 5. Popup (UX-06)

Width 340 px, padding 16 px.

### 5.1 Ready-state layout (top to bottom)

1. `h1` "YouTube Music Notes" (16 px).
2. Instrument `select` (Guitar / Flute). Saved in `chrome.storage.local.instrument`.
3. Length: radio group of segmented buttons **30 s · 60 s · 90 s**, default **90 s** (the benchmark length, so new captures compare with existing data). The last choice is saved in `chrome.storage.local.captureSeconds`.
4. Preview line (13 px): "From 1:23 to 2:53 in this video". Refreshed every 1 s while the popup is open in the Ready state.
5. Primary button: "Capture 90 s from 1:23".
6. `<details>` "Advanced": summary adds "· sharing on/off". Inside: the "Share diagnostics" checkbox and its hint (12 px), then a secondary button "Run benchmark (0:00–1:30)", hint "Rewinds the video to 0:00 and records 90 s."
7. Status area (`role="status"`).

The Mode dropdown is **removed** (F9). The popup sends `mode: 'transcribe'` (the `pipeline.js` default), so `result.mode` stays filled. See Q4.

### 5.2 States

`captureState` comes from `service_worker.js:setState`: `idle`, `recording`, `analysing`, `done`, `error`. The popup adds `unavailable`.

| State | Text (status area) | Controls | Progress |
|---|---|---|---|
| unavailable (active tab is not a `youtube.com/watch` or `youtu.be` URL, or has no `<video>`) | "Open a YouTube video to start." | Inputs enabled, Capture and Benchmark disabled | — |
| ready (`idle`) | "Ready." | All enabled | — |
| recording | "Recording 0:42 of 1:30. Keep the video tab playing. You can close this popup." | Inputs disabled. One button: "Stop and analyse" (secondary; analyses what was recorded so far, as `STOP_CAPTURE` does now) | `<progress>` value = elapsed / `segmentSeconds`, capped at 0.99 |
| analysing | "Analysing in Chrome: {stage}." Stage text from the table below | No buttons (no cancel exists) | `<progress>` value from the table |
| done | "Done: {n} notes. The result opened in a new tab." | "Open result" (focuses the existing `result.html` tab or creates one) + "New capture" (back to ready) | — |
| error | `captureMessage` in `--danger`, `role="alert"` | Inputs enabled. Primary button reads "Try again" | — |

Analysis progress is mapped in `service_worker.js` from the `captureMessage` that `ANALYSIS_PROGRESS` already sends. The offscreen bundle does not change.

| `captureMessage` starts with / matches | progress | stage text |
|---|---|---|
| `Analysing exact YouTube segment` | 0.01 | "starting" |
| `Decoding captured audio` | 0.03 | "decoding audio" |
| `Learning tempo` | 0.08 | "finding the beat" |
| `Guitar Ear` | 0.15 | "listening for guitar" |
| `Transcribing locally with Basic Pitch` | 0.30 | "detecting notes" |
| `/Basic Pitch in Chrome… (\d+)%/` | 0.30 + 0.65 × n/100 | "detecting notes {n} %" |
| anything else | keep the last value | keep the last text |

### 5.3 Required service-worker changes (part of UX-06)

1. `statePayload()` adds `progress` (0–1 or null), `stage`, `captureStartedAt` (ms epoch, set when recording starts) and `segmentSeconds`. The popup computes recording progress from these and the clock.
2. New message `GET_VIDEO_POSITION` → `{ ok, videoId, currentTime, duration }`, read from the tab's `<video>` with `chrome.scripting.executeScript`. It returns `{ ok: false }` when the tab is not a YouTube video (→ `unavailable`).
3. `START_SEGMENT_CAPTURE` accepts `startSeconds: 'current'`. The worker reads `video.currentTime`, rounds it down to 0.1 s, and sets `end = min(start + length, duration)`. If `duration − start < 5 s`, it fails with "Less than 5 seconds left in this video." `benchmarkMode` = `'from-current-v1'`. No rewind: `prepareYouTubeSegment` already skips the seek when it is within 0.08 s.
4. The benchmark button keeps the exact current request: `startSeconds: 0`, `endSeconds: 90`, `benchmarkMode: 'fixed-90s-v1'`.
5. The `done` state no longer auto-opens a second result tab if one is already open. It focuses the open one and reloads it.

---

## 6. Visual tokens

### 6.1 Type (Inter, then system-ui; nothing under 12 px)

| Token | Size / line height / weight | Use |
|---|---|---|
| `--fs-h1` | 20 / 28 / 650 | page title (popup: 16 / 22) |
| `--fs-h2` | 16 / 24 / 650 | card titles |
| `--fs-h3` | 14 / 20 / 650 | diagnostics parts |
| `--fs-body` | 14 / 20 / 400 | body, buttons |
| `--fs-small` | 13 / 18 / 400 | meta, status, popup body, fret numbers (600) |
| `--fs-caption` | 12 / 16 / 400 | legend, labels, hints, tooltips |

Fix the existing sizes under 12 px: `result.css` `.noteLabel` 11 px, `.criticFootnote` 11 px; `popup.css` `.hint` 11 px; and the 11 px fret text in `renderGuitar`.

### 6.2 Spacing and shape

A 4 px grid: `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-6` 24, `--sp-8` 32. Card padding 20, gap between cards 16. Radius: controls 8, cards 12. Minimum hit target 32×32 px (the Play button is 40×40).

### 6.3 Colour (theme follows `prefers-color-scheme`; no manual toggle)

Ratios below were measured against both `--bg` and `--surface` (WCAG relative luminance). Text tokens are ≥ 4.5:1. Non-text graphics (`--tab-line`, `--border`) are ≥ 3:1.

| Token | Light | Ratio on surface / bg | Dark | Ratio on surface / bg |
|---|---|---|---|---|
| `--bg` | #F5F5F4 | — | #121212 | — |
| `--surface` | #FFFFFF | — | #1E1E1E | — |
| `--text`, `--tab-fret` | #171717 | 17.9 / 16.4 | #EDEDED | 14.2 / 16.0 |
| `--text-muted` | #595959 | 7.0 / 6.4 | #A8A8A8 | 7.0 / 7.9 |
| `--tab-low` | #6B6B6B | 5.3 / 4.9 | #A0A0A0 | 6.4 / 7.2 |
| `--accent` (links, active note, primary button bg, loop band) | #1D4ED8 | 6.7 / 6.1 | #8AB4F8 | 7.9 / 8.9 |
| `--on-accent` (text on the primary button) | #FFFFFF | 6.7 on accent | #0B1B33 | 8.2 on accent |
| `--bar` | #404040 | 10.4 / 9.5 | #BDBDBD | 8.9 / 10.0 |
| `--playhead` | #C2410C | 5.2 / 4.8 | #FB923C | 7.4 / 8.3 |
| `--danger` | #B91C1C | 6.5 / 5.9 | #F87171 | 6.0 / 6.8 |
| `--success` | #15803D | 5.0 / 4.6 | #4ADE80 | 9.6 / 10.8 |
| `--tab-line`, `--border` | #8C8C8C | 3.4 / 3.1 | #757575 | 3.6 / 4.1 |
| `--focus` | = `--accent` | | = `--accent` | |

Disabled controls: `opacity` is not allowed (the current `.48` fails contrast). Use `--text-muted` text on `--surface` with a `--border` outline, and `cursor: not-allowed`.

---

## 7. Accessibility (UX-07)

1. **Focus order, result page:** header YouTube link → transport (Play, Stop, Source radios, Speed, Loop toggle, Loop clear) → TAB (one tab stop) → Diagnostics summary → the controls inside Diagnostics in §4 order. DOM order matches this; the fixed transport position is CSS only.
2. **TAB keyboard model:** the TAB container is `tabindex="0"`, `role="group"`, `aria-label="TAB, {n} notes. Use left and right arrows to move between notes."`. It keeps a cursor event (roving, drawn with a 2 px `--focus` box).
   - ← / → move to the previous / next event. Home / End go to the first / last.
   - Enter seeks the transport to the event.
   - Shift + ← / → extends a loop selection from the cursor.
   - On every move, the polite live region reads: "0:12.3, chord: string 1 fret 0, string 2 fret 1, string 3 fret 0" or "0:14.0, string 3 fret 2, low confidence".
3. **Live regions:**
   - Result page: one `<div role="status" aria-live="polite" class="visually-hidden">` for transport changes (play, pause, finished, source, rate, loop set or cleared) and TAB cursor reads. The time display is **not** live.
   - Popup: the status area is `role="status"`. Errors use `role="alert"`. `<progress>` has `aria-label="Recording progress"` / `"Analysis progress"` and `aria-valuetext` (for example "42 of 90 seconds", "detecting notes 55 percent").
4. **Every control is a native element:** `button`, `input type=range`, radio inputs styled as segments, `select`, `details/summary`, `a`. No `div` buttons. Each icon-only button has an `aria-label`. Segmented groups are `fieldset` + `legend` (the legend may be visually hidden).
5. **Pointer-only actions have keyboard equivalents:** loop drag → A/B keys or Shift+arrows in the TAB; click-to-seek → Enter on the TAB cursor; tooltip → shown on focus as well as hover, and closed with Esc.
6. **Focus ring:** 2 px solid `--focus`, 2 px offset, on `:focus-visible`, for every focusable element including SVG events. Never `outline: none` without a replacement.
7. **Motion:** with `prefers-reduced-motion: reduce`, use instant scroll and no CSS transitions (this also covers the current `#playbackProgress` transition).
8. **Text alternative:** the notes table (§4.4) is the full text version of the TAB. Each line `svg` has the `aria-label` from §2.10.
9. **Zoom:** usable at 200 % browser zoom. The rules in §2.1.6 and §3.1 keep the content within the width without a horizontal scrollbar.
10. **Language:** `<html lang="en">` on `result.html` and `popup.html` (both lack it now).

---

## 8. Mapping to tasks

| Task | Implements | Replaces / removes |
|---|---|---|
| UX-03 TAB | §1 (header, notice, TAB card, empty states), §2 | `result.js:renderGuitar`, `result.js:renderFlute`, the `#chart`/`#chartTitle` card and `#meta` text in `result.html`, the `result.css` rules `svg{min-width:900px}`, `#chart` and `.noteLabel` |
| UX-04 Transport | §3 | `result.js:startPlayback`, `stopPlayback`, `scheduleAhead`, `updatePlaybackUi` (its `tr.playing` part moves to §2.8); `original-audio.js:playOriginalAudio`, `stopOriginalAudio`, the button wiring in `initOriginalAudio`; `clean-playback.js:playClean`, `playRhythmGuitar`, `playViolinLegato`, `stopCleanPlayback` (turned into voices, §3.6), and both `DOMContentLoaded` button builders; `result.html` `#originalAudioCard`, `.playbackCard`, `#capturedOriginalAudio[controls]`, `#playbackProgress`; `result.js` `#openOriginal` handler (becomes the header link) |
| UX-05 Diagnostics | §4 | `result.html` `.criticCard` and the notes-table card; `critic.js:runCritic`/`renderCritic` (re-hosted, logic unchanged); `result.js:renderTable` (extra columns, row click); `clean-playback.js:showLocalGapSummary` (re-hosted); `result.js` `#downloadJson`/`#downloadMidi` handlers and `original-audio.js` `#downloadOriginalAudio` handler (moved). Also: load the result **once** in `result.js` and share it, replacing the four copies `result.js:loadLatestResult`, `original-audio.js:loadOriginalAudioResult`, `clean-playback.js:cleanLoadResult`, `critic.js:loadCriticResult` |
| UX-06 Capture choice | §5 | `popup.html` (Mode select, fixed "Section" line, two buttons); `popup.js:applyState`, the `startBtn` handler (hard-coded `BENCHMARK_START_SECONDS`/`BENCHMARK_END_SECONDS`), the `stopBtn` handler; `popup.css`; `service_worker.js:statePayload`, the `START_SEGMENT_CAPTURE` branch (accepts `'current'`), the `ANALYSIS_PROGRESS` branch (progress mapping), the `ANALYSIS_READY` branch (tab reuse); a new `GET_VIDEO_POSITION` handler. Update the `manifest.json` `description` ("first 90 seconds" is no longer true) |
| UX-07 Accessibility | §6, §7 | Every `result.css`/`popup.css` size under 12 px; `button:disabled{opacity:.48}` in both CSS files; adds `lang`, live regions, the TAB keyboard model and focus styles across the UX-03 to UX-06 output |

Suggested order: UX-03 → UX-04 (needs TAB time mapping) → UX-05 → UX-06 (independent) → UX-07 last.

---

## 9. Open questions for the owner

| # | Question | Recommended default |
|---|---|---|
| Q1 | The data has no downbeat or time signature (F4). Is "4/4, bar 1 = first detected beat" acceptable? | Yes, with "Bars assume 4/4" in the legend. Add downbeat detection to the engine backlog. |
| Q2 | Should time labels show video time (`benchmark.startSeconds + t`) or capture time? The recorder starts slightly before the video plays, so video time can be early by roughly 0.1–0.3 s (the offset is not stored). | Video time on the TAB, capture time in the transport clock. Store `actualPlaybackStartSeconds` (already computed in `service_worker.js`) in `benchmark` later to remove the offset. |
| Q3 | Default transport source when the captured audio exists? | Both. |
| Q4 | Remove the Mode dropdown now (it does nothing in the browser build, F9), or show it disabled as "coming soon"? | Remove it and send `mode: 'transcribe'`. Bring it back when an arrange step exists in `pipeline.js`. |
| Q5 | The flute low-confidence threshold is new (0.30 on Basic Pitch amplitude); there is no existing flute constant. | 0.30. Re-check on the first flute benchmark. |
