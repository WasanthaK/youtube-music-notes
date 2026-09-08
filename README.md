# YouTube Music Notes — Chrome MVP

A local-first Chrome extension that captures audio from the current browser tab and creates a basic playable note chart for **guitar** or **flute**.

## What this MVP does

- Captures current Chrome tab audio after you click **Start capture**.
- Keeps the captured audio audible while recording.
- Sends the captured audio to a local FastAPI service at `127.0.0.1:8765`.
- Uses Spotify **Basic Pitch** for automatic music transcription.
- Guitar: displays an MVP six-string TAB and string/fret positions.
- Flute: reduces the transcription to an approximate monophonic melody and displays it on a lightweight treble staff.
- Exports raw transcription as MIDI and processed note data as JSON.
- Optional: if `demucs` is installed, Guitar + Transcribe mode attempts the experimental 6-stem guitar separation before transcription.

## Important limitation

This is an automatic transcription assistant, not a perfect score engraver. Dense mixes, distorted guitars, drums, overlapping instruments, reverb and vocals can all create errors. A production version should add beat/key detection, bar quantization, chord recognition, fingering optimization and manual note editing.

## 1. Install ffmpeg

On Windows, install ffmpeg and make sure `ffmpeg.exe` is available in your PATH.

Example using winget if available:

```powershell
winget install Gyan.FFmpeg
```

Open a new PowerShell and verify:

```powershell
ffmpeg -version
```

## 2. Start the local transcription server

Open PowerShell in the `backend` folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start_windows.ps1
```

Then check:

`http://127.0.0.1:8765/health`

You should see JSON with `"ok": true`.

### Optional guitar source separation

For a better attempt at isolating actual guitar from a full song:

```powershell
pip install demucs
```

The server will detect the `demucs` executable automatically and use `htdemucs_6s` in Guitar + Transcribe mode. This is optional and can be slow.

## 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder in this project.

## 4. Use it

1. Open YouTube or YouTube Music in Chrome.
2. Play the song.
3. Click the extension icon.
4. Choose **Guitar** or **Flute**.
5. Choose:
   - **Arrange melody for instrument** — generate a practical melodic part from the mix.
   - **Transcribe recorded part** — try to capture what is actually present; guitar can optionally use Demucs stem separation.
6. Click **Start capture**.
7. Let 20–60 seconds play.
8. Click **Stop & analyse**.
9. A result tab opens with the chart and export buttons.

## Recommended next version

- Synchronize notes to the YouTube playhead.
- Detect BPM/time signature and quantize into measures.
- Detect key and accidentals correctly.
- Add chord names above guitar staff.
- Optimize guitar fingering using dynamic programming instead of lowest-fret heuristics.
- Add standard notation + TAB together for guitar.
- Add MusicXML/PDF export.
- Add an editable score so the user can correct AI mistakes.
- Process the song in streaming 10–20 second windows for near-real-time updates.
- Add more instruments (piano, bass, saxophone, violin).

## Copyright / usage

Use this as a personal transcription and practice tool. Copyright rules for distributing or publishing transcriptions vary by jurisdiction and by the music involved; do not assume an automatically generated score is free to redistribute.
