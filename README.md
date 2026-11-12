# YouTube Music Notes

YouTube Music Notes is a Manifest V3 Chrome extension (version 0.5.7). On a YouTube or YouTube Music tab, it restarts the video, records the first 90 seconds of the tab audio, and transcribes the guitar into six-string TAB with string and fret positions. All analysis runs in Chrome. The audio is not uploaded.

## What it does

- Records the first 90 seconds of the current tab (0:00 to 1:30). The video restarts from the beginning.
- For guitar, produces six-string TAB with a string and fret for each note.
- For flute, produces a simple single-line melody on a staff.
- Opens a result page with:
  - the guitar TAB and a note table;
  - playback of the transcription and of the original captured audio, including 0.75x speed;
  - MIDI and JSON export;
  - an **Analyze with AI** button (see Privacy).

Two models run in the browser. Spotify Basic Pitch detects pitch, and it is bundled in the extension. Guitar Ear v0.2d is the project's own small ONNX model. It detects guitar presence and string attacks, and it runs with ONNX Runtime Web. Tempo and beat estimation, a musical decoder and a fretboard position solver run after them.

## Install

There is no Chrome Web Store listing. Use one of these two methods.

### Option 1: Download the build artifact

1. In the repository's GitHub Actions tab, open a successful run of the **Build Chrome extension** workflow.
2. Download the artifact named `youtube-music-notes-v0.5.7-musical-guitar-decoder`.
3. Unzip it. The folder contains `manifest.json`.
4. Open `chrome://extensions` and turn on **Developer mode**.
5. Click **Load unpacked** and select the unzipped folder.

### Option 2: Build locally

The CI workflow uses Node.js 22.

1. In the `extension/` folder, run `npm install`.
2. Run `npm run build`.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the `extension` folder.

## Use

1. Open a video on YouTube or YouTube Music in Chrome.
2. Click the extension icon.
3. Choose the **Instrument**: Guitar or Flute.
4. Check the **Mode**. The popup offers **Arrange melody for instrument** and **Transcribe recorded part**.
5. Click **Transcribe first 90 seconds**.
6. Wait while the section is recorded and analyzed.
7. A result tab opens.

## Privacy

**What runs where.** Capture, transcription, tempo estimation, decoding and fretboard solving all run in Chrome. The captured audio stays in the browser. The model files ship with the extension.

**What leaves the machine.**

- **Analyze with AI** runs only when you click it. It sends the detected notes, a summary of the run, the engine name, the video title and the duration to a Supabase Edge Function. The function calls OpenAI. Audio is not sent.
- **Share diagnostics** is a checkbox in the popup. It is off by default. When it is on, each run uploads a row to a Supabase table. The row holds the YouTube video ID and URL, the video title, run metrics and note counts, the full list of detected notes (timing, pitch, confidence, string and fret), tempo and rhythm data, the browser user agent, and a compact model summary. Audio is not sent. The row has no account field, but it does identify the video.

## Limits

- Automatic transcription is imperfect. Dense mixes, distorted guitar, heavy reverb and vocals can produce errors.
- Only the first 90 seconds are transcribed.
- Timing is not yet quantized into bars.
- The TAB cannot be edited.

## Development

Run these commands from the `extension/` folder. They are the commands in `.github/workflows/build-extension.yml`, in workflow order.

Before the build:

1. `npm install`
2. `node scripts/check-version.mjs`
3. `node scripts/test-tempo-analysis.mjs`
4. `node scripts/test-rhythm-stroke-merge.mjs`
5. `node scripts/test-guitar-musical-decoder.mjs`

Build:

6. `npm run build` (runs `vite build`, then `node scripts/copy-ort-assets.mjs`, then `node scripts/copy-basic-pitch-model.mjs`)

After the build:

7. `node scripts/verify-models.mjs`
8. `node scripts/validate-v054.mjs`

The workflow then copies the extension files and `dist/` into a package folder and uploads it as the build artifact.

## Repository layout

- `extension/`: the extension, which is the product.
- `backend/`: the original Python/FastAPI prototype. The extension no longer uses it.
- `research/guitar_ear/`: early model experiments. Training now lives in a separate private repository.
- `web/`: a small site deployed to GitHub Pages.
- `docs/`: architecture notes and benchmarks.
- `RELEASE_NOTES_*.md`: release notes for earlier versions.

For the architecture, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Parts of that file describe the earlier server-based design, so read it as background.

## Copyright / usage

Use this as a personal transcription and practice tool. Copyright rules for distributing or publishing transcriptions vary by jurisdiction and by the music involved; do not assume an automatically generated score is free to redistribute.
