from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

try:
    import torch
    from torch import nn
except Exception as exc:  # Keep the API usable when the optional model runtime is absent.
    torch = None
    nn = None
    _TORCH_IMPORT_ERROR: Exception | None = exc
else:
    _TORCH_IMPORT_ERROR = None


BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_CALIBRATION = {
    "model": "guitar-ear-v0.2d-hardneg.best.pt",
    "sample_rate": 16000,
    "segment_seconds": 3.0,
    "presence_frame_threshold": 0.35,
    "presence_segment_threshold": 0.375,
    "presence_clip_threshold": 0.375,
    "attack_threshold": 0.55,
    "attack_match_tolerance_ms": 50.0,
    "attack_min_peak_distance_ms": 50.0,
    "selection_policy": "thresholds selected on validation only and frozen before held-out test/product use",
}

_RUNTIME_LOCK = threading.Lock()
_RUNTIME: "GuitarEarRuntime | None" = None


def _load_calibration() -> tuple[dict[str, Any], Path | None]:
    candidates: list[Path] = []
    if os.getenv("GUITAR_EAR_CALIBRATION"):
        candidates.append(Path(os.environ["GUITAR_EAR_CALIBRATION"]).expanduser())
    candidates.extend([
        BACKEND_DIR / "guitar_ear_calibration.json",
        Path(r"C:\guitar-ear-data\checkpoints\guitar-ear-v0.2d-calibration.json"),
    ])
    for path in candidates:
        if path.is_file():
            try:
                payload = json.loads(path.read_text(encoding="utf-8-sig"))
                return {**DEFAULT_CALIBRATION, **payload}, path
            except Exception:
                continue
    return dict(DEFAULT_CALIBRATION), None


def _checkpoint_candidates(calibration: dict[str, Any]) -> list[Path]:
    paths: list[Path] = []
    if os.getenv("GUITAR_EAR_CHECKPOINT"):
        paths.append(Path(os.environ["GUITAR_EAR_CHECKPOINT"]).expanduser())
    model_name = str(calibration.get("model") or DEFAULT_CALIBRATION["model"])
    paths.extend([
        BACKEND_DIR / "models" / model_name,
        BACKEND_DIR / model_name,
        Path(r"C:\guitar-ear-data\checkpoints") / model_name,
    ])
    return paths


def _find_checkpoint(calibration: dict[str, Any]) -> Path | None:
    for path in _checkpoint_candidates(calibration):
        if path.is_file():
            return path
    return None


def _decode_audio_ffmpeg(path: str | Path, sample_rate: int) -> np.ndarray:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found in PATH")
    proc = subprocess.run(
        [
            ffmpeg,
            "-v", "error",
            "-i", str(path),
            "-vn",
            "-ac", "1",
            "-ar", str(sample_rate),
            "-f", "f32le",
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", errors="replace")[-600:]
        raise RuntimeError("Guitar Ear could not decode audio: " + message)
    audio = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=True)
    if audio.size == 0:
        raise RuntimeError("Guitar Ear decoded empty audio")
    return audio


def _peak_frames(prob: np.ndarray, threshold: float, min_distance_frames: int) -> list[int]:
    if prob.size < 3:
        return []
    candidates = [
        index
        for index in range(1, len(prob) - 1)
        if prob[index] >= threshold
        and prob[index] >= prob[index - 1]
        and prob[index] >= prob[index + 1]
    ]
    kept: list[int] = []
    for index in candidates:
        if not kept or index - kept[-1] >= min_distance_frames:
            kept.append(index)
        elif prob[index] > prob[kept[-1]]:
            kept[-1] = index
    return kept


if nn is not None:
    def _hz_to_mel(hz: torch.Tensor) -> torch.Tensor:
        return 2595.0 * torch.log10(1.0 + hz / 700.0)


    def _mel_to_hz(mel: torch.Tensor) -> torch.Tensor:
        return 700.0 * (torch.pow(10.0, mel / 2595.0) - 1.0)


    def _build_mel_filterbank(
        sample_rate: int,
        n_fft: int,
        n_mels: int,
        f_min: float,
        f_max: float,
    ) -> torch.Tensor:
        n_freqs = n_fft // 2 + 1
        fft_freqs = torch.linspace(0.0, sample_rate / 2, n_freqs)
        mel_min = _hz_to_mel(torch.tensor(float(f_min)))
        mel_max = _hz_to_mel(torch.tensor(float(f_max)))
        mel_points = torch.linspace(mel_min, mel_max, n_mels + 2)
        hz_points = _mel_to_hz(mel_points)
        fb = torch.zeros(n_mels, n_freqs)
        for m in range(n_mels):
            left, center, right = hz_points[m:m + 3]
            up = (fft_freqs - left) / max(float(center - left), 1e-9)
            down = (right - fft_freqs) / max(float(right - center), 1e-9)
            fb[m] = torch.clamp(torch.minimum(up, down), min=0.0)
        return fb


    class LogMelFrontend(nn.Module):
        def __init__(
            self,
            sample_rate: int = 16000,
            n_fft: int = 1024,
            hop_length: int = 160,
            n_mels: int = 96,
            f_min: float = 50.0,
            f_max: float = 7600.0,
        ) -> None:
            super().__init__()
            self.sample_rate = sample_rate
            self.n_fft = n_fft
            self.hop_length = hop_length
            self.n_mels = n_mels
            self.register_buffer("window", torch.hann_window(n_fft), persistent=False)
            self.register_buffer(
                "mel_filter",
                _build_mel_filterbank(sample_rate, n_fft, n_mels, f_min, f_max),
                persistent=False,
            )

        def forward(self, waveform: torch.Tensor) -> torch.Tensor:
            if waveform.ndim == 1:
                waveform = waveform.unsqueeze(0)
            spec = torch.stft(
                waveform,
                n_fft=self.n_fft,
                hop_length=self.hop_length,
                win_length=self.n_fft,
                window=self.window,
                center=True,
                return_complex=True,
            )
            power = spec.abs().pow(2.0)
            mel = torch.einsum("mf,bft->bmt", self.mel_filter, power)
            log_mel = torch.log1p(mel)
            mean = log_mel.mean(dim=(-2, -1), keepdim=True)
            std = log_mel.std(dim=(-2, -1), keepdim=True).clamp_min(1e-5)
            return (log_mel - mean) / std


    class GuitarEar(nn.Module):
        def __init__(self, sample_rate: int = 16000) -> None:
            super().__init__()
            self.frontend = LogMelFrontend(sample_rate=sample_rate)
            self.encoder = nn.Sequential(
                nn.Conv2d(1, 32, kernel_size=3, padding=1),
                nn.BatchNorm2d(32),
                nn.SiLU(),
                nn.MaxPool2d(kernel_size=(2, 1)),
                nn.Conv2d(32, 64, kernel_size=3, padding=1),
                nn.BatchNorm2d(64),
                nn.SiLU(),
                nn.MaxPool2d(kernel_size=(2, 1)),
                nn.Conv2d(64, 96, kernel_size=3, padding=1),
                nn.BatchNorm2d(96),
                nn.SiLU(),
                nn.MaxPool2d(kernel_size=(2, 1)),
            )
            self.temporal = nn.GRU(
                input_size=96,
                hidden_size=96,
                num_layers=2,
                batch_first=True,
                bidirectional=True,
                dropout=0.15,
            )
            self.dropout = nn.Dropout(0.15)
            self.presence_head = nn.Linear(192, 1)
            self.attack_head = nn.Linear(192, 1)

        @property
        def hop_seconds(self) -> float:
            return self.frontend.hop_length / self.frontend.sample_rate

        def forward(self, waveform: torch.Tensor) -> dict[str, torch.Tensor]:
            x = self.frontend(waveform)
            x = self.encoder(x.unsqueeze(1))
            x = x.mean(dim=2).transpose(1, 2)
            x, _ = self.temporal(x)
            x = self.dropout(x)
            return {
                "presence_logits": self.presence_head(x).squeeze(-1),
                "attack_logits": self.attack_head(x).squeeze(-1),
            }


class GuitarEarRuntime:
    def __init__(self) -> None:
        self.calibration, self.calibration_path = _load_calibration()
        self.checkpoint_path = _find_checkpoint(self.calibration)
        self.model = None
        self.device = "unavailable"
        self.error: str | None = None

        if torch is None or nn is None:
            self.error = f"PyTorch unavailable: {_TORCH_IMPORT_ERROR}"
            return
        if self.checkpoint_path is None:
            searched = ", ".join(str(x) for x in _checkpoint_candidates(self.calibration))
            self.error = f"Guitar Ear checkpoint not found. Searched: {searched}"
            return

        try:
            self.device = self._select_device()
            checkpoint = torch.load(self.checkpoint_path, map_location=self.device)
            sample_rate = int(checkpoint.get("sample_rate", self.calibration["sample_rate"]))
            model = GuitarEar(sample_rate=sample_rate).to(self.device)
            model.load_state_dict(checkpoint["model_state"])
            model.eval()
            self.model = model
        except Exception as exc:
            self.error = str(exc)
            self.model = None
            self.device = "unavailable"

    def _select_device(self) -> str:
        requested = os.getenv("GUITAR_EAR_DEVICE", "auto").strip().lower()
        if requested == "cpu":
            return "cpu"
        if requested == "cuda":
            if not torch.cuda.is_available():
                raise RuntimeError("GUITAR_EAR_DEVICE=cuda but CUDA is unavailable")
            return "cuda"
        if torch.cuda.is_available():
            try:
                free_bytes, _total_bytes = torch.cuda.mem_get_info()
                if free_bytes >= 768 * 1024 * 1024:
                    return "cuda"
            except Exception:
                return "cuda"
        return "cpu"

    @property
    def available(self) -> bool:
        return self.model is not None

    def status(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "device": self.device,
            "checkpoint": str(self.checkpoint_path) if self.checkpoint_path else None,
            "calibration": str(self.calibration_path) if self.calibration_path else "built-in frozen v0.2d",
            "model": self.calibration.get("model"),
            "presence_segment_threshold": float(self.calibration["presence_segment_threshold"]),
            "attack_threshold": float(self.calibration["attack_threshold"]),
            "error": self.error,
        }

    def analyze(self, audio_path: str | Path) -> dict[str, Any]:
        if not self.available:
            return self.status()

        sample_rate = int(self.calibration["sample_rate"])
        segment_seconds = float(self.calibration["segment_seconds"])
        segment_samples = int(round(sample_rate * segment_seconds))
        presence_threshold = float(self.calibration["presence_segment_threshold"])
        attack_threshold = float(self.calibration["attack_threshold"])
        min_attack_seconds = float(self.calibration["attack_min_peak_distance_ms"]) / 1000.0
        audio = _decode_audio_ffmpeg(audio_path, sample_rate)
        duration = audio.size / sample_rate

        chunks: list[np.ndarray] = []
        chunk_meta: list[tuple[int, int]] = []
        for start in range(0, audio.size, segment_samples):
            actual = min(segment_samples, audio.size - start)
            chunk = audio[start:start + segment_samples]
            if chunk.size < segment_samples:
                chunk = np.pad(chunk, (0, segment_samples - chunk.size))
            chunks.append(chunk.astype(np.float32, copy=False))
            chunk_meta.append((start, actual))

        segment_scores: list[dict[str, Any]] = []
        attacks: list[float] = []
        presence_values: list[np.ndarray] = []
        active_intervals: list[dict[str, float]] = []
        hop_seconds = float(self.model.hop_seconds)
        hop_samples = int(round(hop_seconds * sample_rate))
        min_attack_frames = max(1, int(round(min_attack_seconds / hop_seconds)))

        with _RUNTIME_LOCK, torch.inference_mode():
            batch_size = 16 if self.device == "cuda" else 4
            for batch_start in range(0, len(chunks), batch_size):
                batch_chunks = chunks[batch_start:batch_start + batch_size]
                waveform = torch.from_numpy(np.stack(batch_chunks)).to(self.device)
                try:
                    output = self.model(waveform)
                except RuntimeError as exc:
                    if self.device == "cuda" and "out of memory" in str(exc).lower():
                        torch.cuda.empty_cache()
                        self.device = "cpu"
                        self.model = self.model.to("cpu")
                        waveform = waveform.cpu()
                        output = self.model(waveform)
                    else:
                        raise
                p_batch = torch.sigmoid(output["presence_logits"]).detach().cpu().numpy()
                a_batch = torch.sigmoid(output["attack_logits"]).detach().cpu().numpy()

                for offset, (p_prob, a_prob) in enumerate(zip(p_batch, a_batch)):
                    index = batch_start + offset
                    start_sample, actual_samples = chunk_meta[index]
                    is_last = index == len(chunks) - 1
                    valid_frames = min(len(p_prob), 1 + actual_samples // hop_samples)
                    if not is_last:
                        valid_frames = max(valid_frames - 1, 1)
                    p_valid = p_prob[:valid_frames].astype(np.float32, copy=False)
                    a_valid = a_prob[:valid_frames].astype(np.float32, copy=False)
                    score = float(p_valid.mean())
                    active = score >= presence_threshold
                    start_s = start_sample / sample_rate
                    end_s = min(duration, (start_sample + actual_samples) / sample_rate)
                    segment_scores.append({
                        "start": round(start_s, 4),
                        "end": round(end_s, 4),
                        "presence": round(score, 6),
                        "active": active,
                    })
                    presence_values.append(p_valid)
                    if active:
                        if active_intervals and start_s <= active_intervals[-1]["end"] + 0.02:
                            active_intervals[-1]["end"] = round(end_s, 4)
                        else:
                            active_intervals.append({"start": round(start_s, 4), "end": round(end_s, 4)})
                        for frame in _peak_frames(a_valid, attack_threshold, min_attack_frames):
                            event_time = start_s + frame * hop_seconds
                            if event_time <= duration:
                                attacks.append(round(event_time, 4))

        all_presence = np.concatenate(presence_values) if presence_values else np.zeros(0, dtype=np.float32)
        active_seconds = sum(max(0.0, interval["end"] - interval["start"]) for interval in active_intervals)
        result = self.status()
        result.update({
            "duration_seconds": round(duration, 4),
            "mean_presence": round(float(all_presence.mean()), 6) if all_presence.size else 0.0,
            "active_fraction": round(active_seconds / max(duration, 1e-9), 6),
            "active_intervals": active_intervals,
            "segment_scores": segment_scores,
            "attack_times": attacks,
            "attack_count": len(attacks),
        })
        return result


def _runtime() -> GuitarEarRuntime:
    global _RUNTIME
    if _RUNTIME is None:
        with _RUNTIME_LOCK:
            if _RUNTIME is None:
                _RUNTIME = GuitarEarRuntime()
    return _RUNTIME


def guitar_ear_status() -> dict[str, Any]:
    return _runtime().status()


def analyze_guitar_audio(audio_path: str | Path) -> dict[str, Any]:
    runtime = _runtime()
    if not runtime.available:
        return runtime.status()
    try:
        return runtime.analyze(audio_path)
    except Exception as exc:
        result = runtime.status()
        result["available"] = False
        result["error"] = str(exc)
        return result
