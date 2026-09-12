from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch

from data import decode_audio_ffmpeg, frame_labels, load_manifest
from model import GuitarEar


@dataclass
class BinaryMetrics:
    threshold: float
    precision: float
    recall: float
    f1: float
    tp: int
    fp: int
    fn: int


@dataclass
class AttackMetrics(BinaryMetrics):
    tolerance_seconds: float


def peak_pick(prob: np.ndarray, threshold: float, min_distance_frames: int) -> list[int]:
    candidates: list[int] = []
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


def binary_metrics(prob: np.ndarray, truth: np.ndarray, threshold: float) -> BinaryMetrics:
    pred = prob >= threshold
    target = truth >= 0.5
    tp = int(np.logical_and(pred, target).sum())
    fp = int(np.logical_and(pred, np.logical_not(target)).sum())
    fn = int(np.logical_and(np.logical_not(pred), target).sum())
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2.0 * precision * recall / max(precision + recall, 1e-12)
    return BinaryMetrics(threshold, precision, recall, f1, tp, fp, fn)


def match_events(predicted: list[float], truth: list[float], tolerance: float) -> tuple[int, int, int]:
    # One-to-one matching by smallest timing error. This prevents one broad peak
    # from claiming multiple labelled attacks and is stable across threshold sweeps.
    candidates: list[tuple[float, int, int]] = []
    for p_idx, pred in enumerate(predicted):
        for t_idx, target in enumerate(truth):
            error = abs(pred - target)
            if error <= tolerance:
                candidates.append((error, p_idx, t_idx))
    candidates.sort()

    used_pred: set[int] = set()
    used_truth: set[int] = set()
    for _, p_idx, t_idx in candidates:
        if p_idx in used_pred or t_idx in used_truth:
            continue
        used_pred.add(p_idx)
        used_truth.add(t_idx)

    tp = len(used_pred)
    fp = len(predicted) - tp
    fn = len(truth) - tp
    return tp, fp, fn


def event_metrics(
    probabilities: list[np.ndarray],
    truths: list[list[float]],
    hop_seconds: float,
    threshold: float,
    tolerance_seconds: float,
    min_distance_seconds: float,
) -> AttackMetrics:
    tp = fp = fn = 0
    min_distance_frames = max(1, round(min_distance_seconds / hop_seconds))
    for prob, target_times in zip(probabilities, truths):
        frames = peak_pick(prob, threshold, min_distance_frames)
        predicted_times = [frame * hop_seconds for frame in frames]
        a, b, c = match_events(predicted_times, target_times, tolerance_seconds)
        tp += a
        fp += b
        fn += c

    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2.0 * precision * recall / max(precision + recall, 1e-12)
    return AttackMetrics(threshold, precision, recall, f1, tp, fp, fn, tolerance_seconds)


def threshold_grid(start: float, stop: float, step: float) -> list[float]:
    count = int(round((stop - start) / step))
    return [round(start + i * step, 6) for i in range(count + 1)]


def choose_presence(rows: list[BinaryMetrics], min_precision: float) -> tuple[BinaryMetrics, str]:
    eligible = [row for row in rows if row.precision >= min_precision]
    if eligible:
        # Guitar Ear is a gate. Once the precision floor is met, preserve as much
        # true guitar as possible. F1 and the higher threshold break ties.
        return max(eligible, key=lambda row: (row.recall, row.f1, row.threshold)), (
            f'highest recall with precision >= {min_precision:.3f}'
        )
    return max(rows, key=lambda row: (row.f1, row.precision, row.recall)), (
        f'fallback: no threshold reached precision >= {min_precision:.3f}; max F1 used'
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Calibrate Guitar Ear thresholds on a labelled validation split only.'
    )
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--split', default='val')
    parser.add_argument('--threshold-start', type=float, default=0.05)
    parser.add_argument('--threshold-stop', type=float, default=0.95)
    parser.add_argument('--threshold-step', type=float, default=0.01)
    parser.add_argument('--presence-min-precision', type=float, default=0.90)
    parser.add_argument('--attack-tolerance-ms', type=float, default=50.0)
    parser.add_argument('--attack-min-distance-ms', type=float, default=55.0)
    parser.add_argument('--model-name', default='guitar-ear-phase-2d')
    parser.add_argument('--out', default='checkpoints/guitar-ear-calibration.json')
    args = parser.parse_args()

    if args.split.lower() in {'test', 'benchmark', 'benchmarks'}:
        raise ValueError('Calibration must use validation data, not test/benchmark data.')

    checkpoint = torch.load(args.checkpoint, map_location='cpu')
    sample_rate = int(checkpoint.get('sample_rate', 16000))
    model = GuitarEar(sample_rate=sample_rate)
    model.load_state_dict(checkpoint['model_state'])
    model.eval()

    hop_seconds = float(checkpoint.get('hop_seconds', model.hop_seconds))
    items = load_manifest(args.manifest, args.split)
    if not items:
        raise ValueError(f'No manifest items for split={args.split!r}')

    presence_probs: list[np.ndarray] = []
    presence_truths: list[np.ndarray] = []
    attack_probs: list[np.ndarray] = []
    attack_truths: list[list[float]] = []
    sources: dict[str, int] = {}

    for index, item in enumerate(items, start=1):
        sources[item.source] = sources.get(item.source, 0) + 1
        audio = decode_audio_ffmpeg(item.audio, sample_rate)
        waveform = torch.from_numpy(audio).unsqueeze(0)

        with torch.no_grad():
            out = model(waveform)
            presence = torch.sigmoid(out['presence_logits'])[0].cpu().numpy()
            attack = torch.sigmoid(out['attack_logits'])[0].cpu().numpy()

        n_frames = min(len(presence), len(attack))
        presence = presence[:n_frames]
        attack = attack[:n_frames]
        presence_target, _ = frame_labels(
            n_frames=n_frames,
            hop_seconds=hop_seconds,
            crop_start_seconds=0.0,
            presence_intervals=item.presence_intervals,
            attack_times=item.attack_times,
            weak_guitar_present=item.guitar_present,
        )

        if item.presence_intervals is not None or item.guitar_present is not None:
            presence_probs.append(presence)
            presence_truths.append(presence_target)

        # None means 'not labelled'. An explicit [] is a valid negative attack example.
        if item.attack_times is not None:
            attack_probs.append(attack)
            attack_truths.append([float(value) for value in item.attack_times])

        print(
            json.dumps(
                {
                    'item': index,
                    'total': len(items),
                    'audio': item.audio,
                    'source': item.source,
                    'presence_labelled': item.presence_intervals is not None or item.guitar_present is not None,
                    'attack_labelled': item.attack_times is not None,
                }
            )
        )

    thresholds = threshold_grid(args.threshold_start, args.threshold_stop, args.threshold_step)

    if not presence_probs:
        raise ValueError('Validation split contains no presence labels.')
    p_prob = np.concatenate(presence_probs)
    p_truth = np.concatenate(presence_truths)
    presence_rows = [binary_metrics(p_prob, p_truth, threshold) for threshold in thresholds]
    chosen_presence, presence_rule = choose_presence(presence_rows, args.presence_min_precision)

    if not attack_probs:
        raise ValueError('Validation split contains no attack labels.')
    attack_rows = [
        event_metrics(
            attack_probs,
            attack_truths,
            hop_seconds=hop_seconds,
            threshold=threshold,
            tolerance_seconds=args.attack_tolerance_ms / 1000.0,
            min_distance_seconds=args.attack_min_distance_ms / 1000.0,
        )
        for threshold in thresholds
    ]
    chosen_attack = max(attack_rows, key=lambda row: (row.f1, row.precision, row.recall))

    result = {
        'model': args.model_name,
        'checkpoint': str(Path(args.checkpoint)),
        'manifest': str(Path(args.manifest)),
        'calibration_split': args.split,
        'benchmark_used_for_tuning': False,
        'sample_rate': sample_rate,
        'hop_seconds': hop_seconds,
        'validation_items': len(items),
        'source_counts': sources,
        'selection': {
            'presence_rule': presence_rule,
            'attack_rule': 'maximum event-level F1',
            'attack_tolerance_ms': args.attack_tolerance_ms,
            'attack_min_distance_ms': args.attack_min_distance_ms,
        },
        'frozen_thresholds': {
            'presence': chosen_presence.threshold,
            'attack': chosen_attack.threshold,
        },
        'chosen_metrics': {
            'presence': asdict(chosen_presence),
            'attack': asdict(chosen_attack),
        },
        'sweeps': {
            'presence': [asdict(row) for row in presence_rows],
            'attack': [asdict(row) for row in attack_rows],
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding='utf-8')

    print('\nCalibration complete')
    print(json.dumps(result['frozen_thresholds'], indent=2))
    print(json.dumps(result['chosen_metrics'], indent=2))
    print(f'wrote {out_path}')


if __name__ == '__main__':
    main()
