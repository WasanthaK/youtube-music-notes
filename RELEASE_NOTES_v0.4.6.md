# YouTube Music Notes v0.4.6

This release promotes the validated Guitar Ear Phase-2d integration into the main product path.

## Highlights

- Integrates **Guitar Ear Phase-2d** with the existing Basic Pitch guitar transcription pipeline.
- Uses frozen validation-derived thresholds:
  - Guitar presence segment threshold: **0.375**
  - Guitar attack threshold: **0.55**
- Uses Guitar Ear as evidence for when guitar is actually active before downstream string/fret assignment.
- Retains the existing Basic Pitch/TAB path as a safe fallback if Guitar Ear cannot load.
- Pins `setuptools<81` for compatibility with Basic Pitch/resampy environments that still import `pkg_resources`.

## Validation completed

- Held-out positive/negative smoke pair passed.
- Reserved external benchmark sanity check preserved the Phase-2d separation without retuning thresholds.
- Production `main` backend smoke passed.
- Full HTTP path passed using the same `/transcribe` multipart contract used by the Chrome extension.
- The HTTP E2E test returned **34 playable guitar notes** with valid string/fret assignments and produced renderable six-string TAB.

## Engine

`guitar-ear-v0.2d+basic-pitch-ensemble-v2-python`

## Notes

Demucs remains optional. The Guitar Ear + Basic Pitch path works without Demucs, and the backend continues to expose the existing health and transcription endpoints on `127.0.0.1:8765`.
