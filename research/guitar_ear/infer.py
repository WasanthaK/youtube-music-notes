from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from data import decode_audio_ffmpeg
from model import GuitarEar


def peak_pick(prob: np.ndarray, threshold: float, min_distance_frames: int) -> list[int]:
    candidates = []
    for i in range(1, len(prob) - 1):
        if prob[i] >= threshold and prob[i] >= prob[i - 1] and prob[i] >= prob[i + 1]:
            candidates.append(i)

    kept: list[int] = []
    for idx in candidates:
        if not kept or idx - kept[-1] >= min_distance_frames:
            kept.append(idx)
        elif prob[idx] > prob[kept[-1]]:
            kept[-1] = idx
    return kept


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--audio', required=True)
    parser.add_argument('--presence-threshold', type=float, default=0.5)
    parser.add_argument('--attack-threshold', type=float, default=0.5)
    parser.add_argument('--out')
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location='cpu')
    model = GuitarEar(sample_rate=int(checkpoint.get('sample_rate', 16000)))
    model.load_state_dict(checkpoint['model_state'])
    model.eval()

    sr = int(checkpoint.get('sample_rate', 16000))
    audio = decode_audio_ffmpeg(args.audio, sr)
    waveform = torch.from_numpy(audio).unsqueeze(0)

    with torch.no_grad():
        out = model(waveform)
        presence = torch.sigmoid(out['presence_logits'])[0].numpy()
        attack = torch.sigmoid(out['attack_logits'])[0].numpy()

    hop = float(checkpoint.get('hop_seconds', model.hop_seconds))
    attack_frames = peak_pick(
        attack,
        threshold=args.attack_threshold,
        min_distance_frames=max(1, round(0.055 / hop)),
    )

    result = {
        'audio': str(Path(args.audio)),
        'hop_seconds': hop,
        'presence_threshold': args.presence_threshold,
        'attack_threshold': args.attack_threshold,
        'guitar_active_fraction': float((presence >= args.presence_threshold).mean()),
        'mean_guitar_presence': float(presence.mean()),
        'attack_count': len(attack_frames),
        'attack_times': [round(i * hop, 4) for i in attack_frames],
        'presence': [round(float(v), 5) for v in presence],
        'attack': [round(float(v), 5) for v in attack],
    }

    text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding='utf-8')
    else:
        print(text)


if __name__ == '__main__':
    main()
