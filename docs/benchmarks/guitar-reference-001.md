# Guitar transcription benchmark 001

Reference video: https://www.youtube.com/watch?v=OPOxe-0NW0U
YouTube video ID: `OPOxe-0NW0U`
Date: 2026-09-08
Instrument target: Guitar

## Guitar Engine v1 baseline

Observed status from the same reference recording:

- Strict pass: 362
- Balanced pass: 560
- Sensitive pass: 1095
- Merged candidates: 691
- Playable guitar notes: 654
- Onset groups: 254
- Uncertain notes: 112

## Interpretation

The model is detecting substantial musical activity. The main problem is no longer under-detection; it is false positives / harmonics / background-instrument detections, especially in the sensitive pass. String/fret mapping is not currently the primary bottleneck because 654 of 691 merged candidates were playable on guitar.

## v1.1 objective

Keep all merged detections for diagnostics, but only promote reliable events to learner-facing TAB. Promote notes when they have multi-pass consensus, conservative-pass support, or unusually strong/sustained sensitive-only evidence. Track rejected candidates as likely noise rather than deleting them from diagnostics.

## Next measurements

For each subsequent run on this same source, record:

- strict / balanced / sensitive counts
- merged candidates
- teaching candidates
- rejected-as-noise
- sensitive-only detections
- playable notes
- onset groups
- uncertain notes
- average confidence

The goal is not to maximize note count. The goal is to maximize correct, playable teaching notes while minimizing false positives.