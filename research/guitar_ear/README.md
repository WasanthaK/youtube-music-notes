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

## Next steps after v0.1

1. Add negative/non-guitar clips from an openly licensed source.
2. Add synthetic mixes: labelled clean guitar + vocals/drums/bass/piano at randomized SNR.
3. Add Guitar-TECHS for electric-guitar techniques.
4. Compare raw-audio Guitar Ear vs a pretrained music-audio embedding frontend.
5. If v0.1 works, use its activity/attack outputs to gate Basic Pitch instead of further tightening note-density heuristics.
