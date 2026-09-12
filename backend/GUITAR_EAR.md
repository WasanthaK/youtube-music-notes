# Guitar Ear v0.2d integration

Guitar Ear v0.2d is the guitar-activity and physical-attack front end for the existing Basic Pitch guitar transcription pipeline.

## Runtime contract

The production calibration is frozen from validation data and is stored in `guitar_ear_calibration.json`:

- sample rate: 16 kHz mono
- analysis segment: 3.0 seconds
- presence frame threshold: 0.35
- presence segment/clip threshold: 0.375
- physical attack threshold: 0.55
- attack match tolerance used in evaluation: 50 ms
- minimum attack peak distance: 50 ms

Held-out results at those frozen thresholds:

- presence segment F1: 0.8808
- physical attack F1: 0.8900
- physical attack timing MAE: about 9.3 ms

Thresholds were selected on validation only and frozen before held-out test and product use. Do not tune them against the two reserved real-song benchmark clips.

## Checkpoint

Expected model name:

`guitar-ear-v0.2d-hardneg.best.pt`

The runtime searches in this order:

1. `GUITAR_EAR_CHECKPOINT` environment variable
2. `backend/models/guitar-ear-v0.2d-hardneg.best.pt`
3. `backend/guitar-ear-v0.2d-hardneg.best.pt`
4. local development path `C:\guitar-ear-data\checkpoints\guitar-ear-v0.2d-hardneg.best.pt`

For deployment, set `GUITAR_EAR_CHECKPOINT` to the deployed model artifact path. The model binary is intentionally not committed in this integration branch yet; the validated checkpoint remains in the private training artifacts and on the training machine.

Optional overrides:

- `GUITAR_EAR_CALIBRATION` — path to a calibration JSON file. Normally leave unset so the committed frozen config is used.
- `GUITAR_EAR_DEVICE=auto|cuda|cpu` — defaults to `auto`. Auto uses CUDA when enough memory is available and otherwise falls back to CPU.

If PyTorch or the checkpoint is unavailable, the API remains functional and automatically falls back to the existing Basic Pitch teaching-note pipeline.

## Pipeline

For guitar requests:

1. Decode the original captured mix.
2. Guitar Ear analyzes the original mix in 3-second windows.
3. It returns guitar-active intervals and physical attack events.
4. Basic Pitch continues to run its existing strict/balanced/sensitive ensemble; in `transcribe` mode it may still use a Demucs guitar stem.
5. Basic Pitch candidates are grouped into onset/chord groups.
6. Guitar Ear keeps onset groups that are inside a guitar-active region and have a nearby Guitar Ear attack.
7. A very strong three-pass Basic Pitch consensus is retained as a safety fallback for missed Guitar Ear attacks.
8. Surviving onset groups go through the existing guitar string/fret assignment logic.

Guitar Ear therefore acts as evidence for **when guitar is actually playing**, rather than replacing the downstream pitch/TAB engine.

## Training-data licensing

The v0.2d checkpoint was trained/fine-tuned only with open data used under CC BY 4.0 terms:

- GuitarSet — guitar audio and performance annotations, Zenodo record 3371780.
- NSynth — labelled single-note instrument audio, used for non-guitar backgrounds/hard negatives.
- BabySlakh / Slakh — synthetic multitrack mixtures and stems, BabySlakh Zenodo record 4603844.

Keep dataset attribution with distributed model artifacts and any model release notes.

The two real-song benchmark recordings (`75hjfkb6QkY` and `FFdQVbCbW7g`) are evaluation-only and are not part of training data.
