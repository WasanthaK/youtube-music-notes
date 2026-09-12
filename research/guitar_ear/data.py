from __future__ import annotations

import json
import random
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset


@dataclass
class ManifestItem:
    audio: str
    split: str
    source: str = 'unknown'
    license: str = 'unknown'
    guitar_present: bool | None = None
    presence_intervals: list[list[float]] | None = None
    attack_times: list[float] | None = None


def load_manifest(path: str | Path, split: str) -> list[ManifestItem]:
    items: list[ManifestItem] = []
    with open(path, 'r', encoding='utf-8') as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get('split') != split:
                continue
            items.append(ManifestItem(**row))
    return items


def decode_audio_ffmpeg(path: str | Path, sample_rate: int = 16000) -> np.ndarray:
    cmd = [
        'ffmpeg', '-v', 'error', '-i', str(path),
        '-f', 'f32le', '-acodec', 'pcm_f32le',
        '-ac', '1', '-ar', str(sample_rate), 'pipe:1',
    ]
    proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE)
    audio = np.frombuffer(proc.stdout, dtype='<f4').astype(np.float32, copy=False)
    if audio.size == 0:
        raise ValueError(f'No decoded samples from {path}')
    peak = float(np.max(np.abs(audio)))
    if peak > 1.0:
        audio = audio / peak
    return audio


def frame_labels(
    n_frames: int,
    hop_seconds: float,
    crop_start_seconds: float,
    presence_intervals: list[list[float]] | None,
    attack_times: list[float] | None,
    weak_guitar_present: bool | None,
    attack_sigma_seconds: float = 0.025,
) -> tuple[np.ndarray, np.ndarray]:
    times = crop_start_seconds + np.arange(n_frames, dtype=np.float32) * hop_seconds

    presence = np.zeros(n_frames, dtype=np.float32)
    if presence_intervals:
        for start, end in presence_intervals:
            presence[(times >= float(start)) & (times <= float(end))] = 1.0
    elif weak_guitar_present is True:
        presence[:] = 1.0

    attack = np.zeros(n_frames, dtype=np.float32)
    if attack_times:
        for attack_time in attack_times:
            delta = (times - float(attack_time)) / attack_sigma_seconds
            attack = np.maximum(attack, np.exp(-0.5 * delta * delta).astype(np.float32))

    return presence, attack


class GuitarEarDataset(Dataset):
    def __init__(
        self,
        manifest_path: str | Path,
        split: str,
        sample_rate: int = 16000,
        crop_seconds: float = 3.0,
        hop_length: int = 160,
        training: bool = True,
    ) -> None:
        self.items = load_manifest(manifest_path, split)
        if not self.items:
            raise ValueError(f'No manifest items for split={split!r}')
        self.sample_rate = sample_rate
        self.crop_seconds = crop_seconds
        self.crop_samples = int(round(sample_rate * crop_seconds))
        self.hop_seconds = hop_length / sample_rate
        self.training = training

    def __len__(self) -> int:
        return len(self.items)

    def _crop(self, audio: np.ndarray) -> tuple[np.ndarray, int]:
        if audio.size < self.crop_samples:
            audio = np.pad(audio, (0, self.crop_samples - audio.size))
            return audio, 0

        max_start = audio.size - self.crop_samples
        if self.training and max_start > 0:
            start = random.randint(0, max_start)
        else:
            start = max_start // 2
        return audio[start:start + self.crop_samples], start

    def _augment(self, audio: np.ndarray) -> np.ndarray:
        if not self.training:
            return audio
        gain_db = random.uniform(-8.0, 5.0)
        audio = audio * (10.0 ** (gain_db / 20.0))
        if random.random() < 0.45:
            noise_rms = random.uniform(0.0003, 0.006)
            audio = audio + np.random.normal(0.0, noise_rms, size=audio.shape).astype(np.float32)
        return np.clip(audio, -1.0, 1.0).astype(np.float32)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        item = self.items[index]
        audio = decode_audio_ffmpeg(item.audio, self.sample_rate)
        crop, start_sample = self._crop(audio)
        crop = self._augment(crop)

        start_seconds = start_sample / self.sample_rate
        n_frames = 1 + self.crop_samples // int(round(self.hop_seconds * self.sample_rate))
        presence, attack = frame_labels(
            n_frames=n_frames,
            hop_seconds=self.hop_seconds,
            crop_start_seconds=start_seconds,
            presence_intervals=item.presence_intervals,
            attack_times=item.attack_times,
            weak_guitar_present=item.guitar_present,
        )

        return {
            'waveform': torch.from_numpy(crop.copy()),
            'presence': torch.from_numpy(presence),
            'attack': torch.from_numpy(attack),
        }
