# YouTube Music Notes v0.4.8

This release fixes local backend access from the packaged Chrome extension.

## Fixed
- Adds required Chrome host access for the local Guitar Ear backend.
- Keeps transcription routed through the Phase-2d backend on port 8765.
- Replaces the generic fetch failure with a clear backend connection message.
- CI now verifies the packaged backend route and local host permissions.

Expected engine: `guitar-ear-v0.2d+basic-pitch-ensemble-v2-python`
