# Guitar Ear v0.1

A research module for learning **when guitar is present** and **when a guitarist initiates a new note/chord attack**.

This deliberately sits *before* pitch-to-TAB transcription.

## Why

The current browser transcription engine can produce similar note density for a guitar-dominant recording and a mixed vocal song. The new architecture separates two questions:

1. **Is guitar active here?**
2. **Did the guitar initiate a new attack here?**

Only after those are answered should a pitch engine decide *which* notes were played.

## Model

`GuitarEar` is a compact CRNN:

- input: mono 16 kHz waveform
- frontend: 96-bin log-mel spectrogram, 10 ms hop
- encoder: 3 convolution blocks
- temporal model: 2-layer bidirectional GRU
- output head 1: frame-level `guitar_presence`
- output head 2: frame-level `guitar_attack`

The first version is intentionally small so a successful model can later be distilled/exported for browser inference.

## Training manifest

JSONL, one object per recording:

```json
{
  "audio": "D:/datasets/guitarset/audio/example.wav",
  "split": "train",
  "source": "GuitarSet",
  "license": "CC-BY-4.0",
  "guitar_present": true,
  "presence_intervals": [[0.0, 30.0]],
  "attack_times": [0.412, 0.891, 1.337]
}
```

For weakly-labelled clips, `guitar_present: true/false` can be used without exact presence intervals. For attack training, exact note/chord onset times are strongly preferred.

## GuitarSet preparation

Use the **mono microphone** mix and JAMS annotations. GuitarSet contains time-aligned note annotations and is suitable for attack supervision. The selective downloader fetches only the annotation archive and mono-microphone audio from the current Zenodo record, rather than the much larger hex-pickup archives.

```bash
python download_guitarset.py --dest data/GuitarSet
```

Then build the training manifest:

```bash
python prepare_guitarset.py \
  --annotations data/GuitarSet/annotation \
  --audio data/GuitarSet/audio_mono-mic \
  --out data/guitarset.jsonl
```

Two tracks with known timing issues are excluded by the script. The split holds out player `05` as test and player `04` as validation, so the primary test guitarist is unseen during training.

## Train

Requires `ffmpeg` in PATH.

```bash
pip install -r requirements.txt

python train.py \
  --manifest data/guitarset.jsonl \
  --epochs 30 \
  --batch-size 24 \
  --out checkpoints/guitar-ear-v0.1.pt
```

A 4090-class GPU should be used when available; the script automatically selects CUDA.

## Infer

```bash
python infer.py \
  --checkpoint checkpoints/guitar-ear-v0.1.pt \
  --audio benchmark.webm \
  --out benchmark-result.json
```

The result includes:

- frame-by-frame guitar-presence probability
- frame-by-frame guitar-attack probability
- peak-picked attack times
- overall fraction of frames considered guitar-active

## Fixed benchmark policy

`benchmarks.json` identifies the two user-supplied evaluation recordings by YouTube ID. The raw audio is **not committed** and should **not be included in training**.

We should only claim progress when:

1. the guitar-dominant reference has clearly stronger guitar presence than the mixed reference;
2. attack counts follow audible guitar attacks rather than an arbitrary density target;
3. improvements hold on GuitarSet's unseen-player test split.

## Phase-2d status

Phase-2d is currently the leading research candidate on the two reserved real-world benchmark recordings.

Observed benchmark behaviour:

| Model | Guitar-dominant mean presence | Mixed-song mean presence | Guitar attacks @ 0.65 | Mixed attacks @ 0.65 |
| --- | ---: | ---: | ---: | ---: |
| Phase-1 | 0.9998 | 0.9999 | 132 | 148 |
| Phase-2c | 0.9944 | 0.9839 | 102 | 90 |
| **Phase-2d** | **0.7713** | **0.4201** | **33** | **4** |

Phase-2d also showed useful presence separation across fixed thresholds:

- `0.50`: guitar-dominant active 92.2% vs mixed song 26.0%
- `0.60`: 78.3% vs 9.8%
- `0.70`: 66.1% vs 1.9%
- `0.80`: 55.3% vs 0.0%

These two real recordings are still **reserved benchmarks**. Their apparent separation must not be used to tune the production thresholds.

## Calibrate and freeze thresholds

Threshold calibration must use labelled validation data only.

Presence calibration is frame-level. Because Guitar Ear is intended to gate downstream transcription, the default selection rule is:

> choose the threshold with the highest recall while validation precision is at least 0.90; if no threshold reaches that precision floor, fall back to maximum F1.

Attack calibration is event-level and uses one-to-one onset matching with a default `±50 ms` tolerance. The selected attack threshold maximizes event-level F1.

Run:

```bash
python calibrate.py \
  --checkpoint checkpoints/guitar-ear-phase-2d.pt \
  --manifest data/phase-2d.jsonl \
  --split val \
  --presence-min-precision 0.90 \
  --attack-tolerance-ms 50 \
  --model-name guitar-ear-phase-2d \
  --out checkpoints/guitar-ear-phase-2d-calibration.json
```

The calibration file records:

- frozen presence threshold
- frozen attack threshold
- validation metrics and full threshold sweeps
- source counts
- onset tolerance and attack peak spacing
- `benchmark_used_for_tuning: false`

`calibrate.py` refuses `test` or `benchmark` as the calibration split.

After calibration:

1. freeze the Phase-2d weights;
2. freeze both thresholds from the validation result;
3. run the held-out test split once with no threshold changes;
4. rerun the two real benchmark recordings as an external sanity check only;
5. do not change thresholds in response to benchmark behaviour.

If held-out performance remains strong, the intended production architecture is:

```text
song
  -> Guitar Ear Phase-2d
  -> guitar-active regions + attack hints
  -> pitch transcriber
  -> fingering / TAB optimizer
  -> guitar TAB / notation
```

## Next steps after v0.1

1. Add negative/non-guitar clips from an openly licensed source.
2. Add synthetic mixes: labelled clean guitar + vocals/drums/bass/piano at randomized SNR.
3. Add Guitar-TECHS for electric-guitar techniques.
4. Compare raw-audio Guitar Ear vs a pretrained music-audio embedding frontend.
5. If v0.1 works, use its activity/attack outputs to gate Basic Pitch instead of further tightening note-density heuristics.
