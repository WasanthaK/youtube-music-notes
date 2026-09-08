# Architecture

## Product direction

YouTube Music Notes is designed as an AI-assisted music learning system, not only a transcription tool.

```text
Audio source
   ↓
Capture / upload
   ↓
Transcription engine
   ↓
Canonical MusicDocument
   ↓
┌───────────────────────────────┐
│ Renderers                     │
│ Guitar TAB / flute / piano... │
└───────────────────────────────┘
   ↓
LLM reasoning layer
   ↓
Explain / simplify / arrange / teach / practice
```

## Canonical MusicDocument

Every transcription is converted into one internal document. Renderers, exports and AI reasoning should consume this object instead of raw model output.

Current schema identifier:

```json
{
  "schema": "youtube-music-notes.music-document",
  "schema_version": "0.1.0"
}
```

Top-level areas:

- `track` — title, source and duration.
- `analysis` — requested instrument, mode, confidence and warnings.
- `tempo` — BPM and confidence.
- `meter` — time signature and confidence.
- `key` — tonic, mode and confidence.
- `sections` — intro, verse, chorus, solo and other detected sections.
- `measures` — future quantized bar representation.
- `chords` — future chord timeline.
- `instruments` — detected and target instruments.
- `notes` — timestamped note events.
- `exports` — MIDI and future MusicXML/PDF references.
- `learning` — difficulty, required skills and practice points.

Unknown musical facts must remain `null` instead of being guessed.

## LLM reasoning

`POST /reason` accepts:

```json
{
  "music_document": {},
  "question": "Explain this phrase and give me a practice exercise",
  "provider": "openai"
}
```

`provider` can currently be `openai` or `gemini`.

The server strips the large MIDI payload and may sample very large note arrays before calling an LLM. Audio itself is not sent to the LLM in this architecture.

## Security

Never put OpenAI or Gemini keys in browser JavaScript, extension files or GitHub Pages.

Use server environment variables:

```text
OPENAI_API_KEY
OPENAI_MODEL
GEMINI_API_KEY
GEMINI_MODEL
DEFAULT_LLM_PROVIDER
```

`.env` files are ignored by Git.

## Near-term roadmap

1. Tempo and beat detection.
2. Key detection.
3. Measure quantization.
4. Chord recognition.
5. Section detection.
6. Better guitar fingering optimization.
7. Browser-side transcription option using Basic Pitch TS.
8. Static GitHub Pages UI.
9. Small secure reasoning API deployment.
10. User learning profile and adaptive exercises.
11. Performance comparison using microphone input.
12. MusicXML and printable score export.
