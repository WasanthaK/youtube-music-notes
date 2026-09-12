from __future__ import annotations

import argparse
import json
from pathlib import Path

import jams


KNOWN_BAD_TIMINGS = {
    '04_BN3-154-E_comp',
    '04_Jazz1-200-B_comp',
}


def split_for_track(stem: str) -> str:
    # Hold out player 05 completely; use player 04 for validation.
    # This avoids testing on the same guitarist seen during training.
    player = stem.split('_', 1)[0]
    if player == '05':
        return 'test'
    if player == '04':
        return 'val'
    return 'train'


def find_audio(audio_root: Path, stem: str) -> Path:
    candidates = [
        audio_root / f'{stem}_mic.wav',
        audio_root / f'{stem}.wav',
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    matches = list(audio_root.rglob(f'{stem}*.wav'))
    if not matches:
        raise FileNotFoundError(f'No audio found for {stem} under {audio_root}')
    return matches[0]


def note_attacks(jam_path: Path) -> list[float]:
    jam = jams.load(str(jam_path))
    annotations = jam.search(namespace='note_midi')
    if not annotations:
        annotations = jam.search(namespace='pitch_midi')
    attacks = []
    for annotation in annotations:
        attacks.extend(float(obs.time) for obs in annotation)
    return sorted(set(round(v, 5) for v in attacks))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--annotations', required=True, help='GuitarSet annotation directory containing .jams files')
    parser.add_argument('--audio', required=True, help='GuitarSet mono microphone audio root')
    parser.add_argument('--out', default='data/guitarset.jsonl')
    args = parser.parse_args()

    annotation_root = Path(args.annotations)
    audio_root = Path(args.audio)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    for jam_path in sorted(annotation_root.rglob('*.jams')):
        stem = jam_path.stem
        if stem in KNOWN_BAD_TIMINGS:
            continue
        audio_path = find_audio(audio_root, stem)
        rows.append({
            'audio': str(audio_path.resolve()),
            'split': split_for_track(stem),
            'source': 'GuitarSet',
            'license': 'CC-BY-4.0',
            'guitar_present': True,
            'presence_intervals': None,
            'attack_times': note_attacks(jam_path),
        })

    with out.open('w', encoding='utf-8') as handle:
        for row in rows:
            handle.write(json.dumps(row) + '\n')

    print(f'wrote {len(rows)} rows to {out}')


if __name__ == '__main__':
    main()
