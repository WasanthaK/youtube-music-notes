from __future__ import annotations

import torch
from torch import nn


def hz_to_mel(hz: torch.Tensor) -> torch.Tensor:
    return 2595.0 * torch.log10(1.0 + hz / 700.0)


def mel_to_hz(mel: torch.Tensor) -> torch.Tensor:
    return 700.0 * (torch.pow(10.0, mel / 2595.0) - 1.0)


def build_mel_filterbank(
    sample_rate: int,
    n_fft: int,
    n_mels: int,
    f_min: float,
    f_max: float,
) -> torch.Tensor:
    n_freqs = n_fft // 2 + 1
    fft_freqs = torch.linspace(0.0, sample_rate / 2, n_freqs)

    mel_min = hz_to_mel(torch.tensor(float(f_min)))
    mel_max = hz_to_mel(torch.tensor(float(f_max)))
    mel_points = torch.linspace(mel_min, mel_max, n_mels + 2)
    hz_points = mel_to_hz(mel_points)

    fb = torch.zeros(n_mels, n_freqs)
    for m in range(n_mels):
        left, center, right = hz_points[m : m + 3]
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
        self.register_buffer('window', torch.hann_window(n_fft), persistent=False)
        self.register_buffer(
            'mel_filter',
            build_mel_filterbank(sample_rate, n_fft, n_mels, f_min, f_max),
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
        mel = torch.einsum('mf,bft->bmt', self.mel_filter, power)
        log_mel = torch.log1p(mel)
        mean = log_mel.mean(dim=(-2, -1), keepdim=True)
        std = log_mel.std(dim=(-2, -1), keepdim=True).clamp_min(1e-5)
        return (log_mel - mean) / std


class GuitarEar(nn.Module):
    """Small frame-level guitar listener.

    Inputs:
        waveform: [batch, samples] float32 mono in [-1, 1]
    Outputs:
        presence_logits: [batch, frames]
        attack_logits: [batch, frames]
    """

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
        x = self.frontend(waveform)              # [B, mel, T]
        x = self.encoder(x.unsqueeze(1))         # [B, C, mel/8, T]
        x = x.mean(dim=2).transpose(1, 2)        # [B, T, C]
        x, _ = self.temporal(x)                  # [B, T, 192]
        x = self.dropout(x)
        return {
            'presence_logits': self.presence_head(x).squeeze(-1),
            'attack_logits': self.attack_head(x).squeeze(-1),
        }
