# YouTube Music Notes v0.4.7

v0.4.7 fixes the Chrome runtime packaging issue discovered after the v0.4.6 release.

## What was wrong in v0.4.6

The source-level `extension/offscreen.js` correctly routed captured audio to the local Phase-2d backend, but the packaged extension loaded `dist/offscreen.bundle.js`. Vite was still building that bundle from the legacy `src/offscreen-browser.js`, so Chrome continued to run the browser-only Basic Pitch v1.2 engine.

## Fixed in v0.4.7

- The packaged offscreen bundle is now built from the backend-routing `extension/offscreen.js`.
- Captured audio is POSTed to `http://127.0.0.1:8765/transcribe` and uses the integrated Guitar Ear Phase-2d + Basic Pitch pipeline.
- The backend result and original captured audio are saved to extension IndexedDB so the existing result page, playback, downloads, and AI critic continue to work.
- When the local backend is not configured to mirror diagnostics to Supabase, the result page uses the extension's existing publishable Supabase configuration to upload the Phase-2d diagnostic row.
- CI now verifies the **built bundle** contains the local `/transcribe` endpoint and rejects a package that still contains the legacy browser-only v1.2 engine marker.

## Expected engine

`guitar-ear-v0.2d+basic-pitch-ensemble-v2-python`

## Frozen Guitar Ear thresholds

- Presence segment threshold: **0.375**
- Attack threshold: **0.55**
