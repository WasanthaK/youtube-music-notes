# Guitar transcription benchmark 001

Reference video: https://www.youtube.com/watch?v=OPOxe-0NW0U
YouTube video ID: `OPOxe-0NW0U`
Date: 2026-09-08
Instrument target: Guitar

## Guitar Engine v1 baseline

Observed status from the reference recording:

- Strict pass: 362
- Balanced pass: 560
- Sensitive pass: 1095
- Merged candidates: 691
- Playable guitar notes: 654
- Onset groups: 254
- Uncertain notes: 112

This original run did not record duration, so it is useful as a historical baseline but cannot be compared by note density.

## Guitar Engine v1.1 normalized run

Observed status from the same YouTube reference source:

- Captured duration: 71.7 seconds
- Strict pass: 568
- Balanced pass: 976
- Sensitive pass: 1860
- Merged candidates: 1869
- Teaching candidates: 958
- Rejected as likely noise: 911
- Sensitive-only merged candidates: 845
- Playable guitar notes: 892
- Onset groups: 362
- Playable-note density: 12.44 notes/second
- Uncertain playable notes: 152

## Interpretation

The detector is no longer suffering from under-detection. The v1.1 teaching gate rejected 911 of 1869 merged candidates (48.7%) before learner-facing TAB. The strongest remaining warning sign is the 845 sensitive-only candidates, indicating that the sensitive pass is still collecting a large amount of harmonics, background instruments, or low-confidence musical activity from the mixed recording.

String/fret assignment is not the primary bottleneck: 892 of 958 teaching candidates survived as playable guitar notes. The next accuracy work should therefore focus on deciding which detected events actually belong in the guitar part, rather than on fret mapping.

## Canonical comparison fields

Every future run on this reference video should store:

- YouTube video ID and URL
- engine version
- captured duration
- strict / balanced / sensitive counts
- merged candidates
- teaching candidates
- rejected-as-noise
- sensitive-only detections
- playable notes
- playable notes per second
- onset groups
- uncertain notes
- average confidence
- browser/platform metadata

The goal is not to maximize note count. The goal is to maximize correct, playable teaching notes while minimizing false positives.