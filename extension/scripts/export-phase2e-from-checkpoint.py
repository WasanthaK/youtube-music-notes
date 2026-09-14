from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn


class GuitarEarPhase2eCore(nn.Module):
    """Phase-2e ONNX core matching the trained checkpoint module names."""

    def __init__(self) -> None:
        super().__init__()
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
        self.rhythm_encoder = nn.Sequential(
            nn.Linear(8, 32),
            nn.SiLU(),
            nn.Dropout(0.10),
        )
        self.rhythm_residual = nn.Sequential(
            nn.Linear(192 + 32, 64),
            nn.SiLU(),
            nn.Dropout(0.10),
            nn.Linear(64, 1),
        )

    def forward(self, log_mel: torch.Tensor, rhythm: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.encoder(log_mel.unsqueeze(1))
        x = x.mean(dim=2).transpose(1, 2)
        x, _ = self.temporal(x)
        x = self.dropout(x)
        presence_logits = self.presence_head(x).squeeze(-1)
        acoustic_attack_logits = self.attack_head(x).squeeze(-1)
        availability = rhythm[..., 7].clamp(0.0, 1.0)
        rhythm_embedding = self.rhythm_encoder(rhythm)
        raw_delta = self.rhythm_residual(torch.cat([x, rhythm_embedding], dim=-1)).squeeze(-1)
        return presence_logits, acoustic_attack_logits + raw_delta * availability


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--calibration-output', required=True)
    parser.add_argument('--opset', type=int, default=18)
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location='cpu')
    model = GuitarEarPhase2eCore().eval()
    missing, unexpected = model.load_state_dict(checkpoint['model_state'], strict=False)
    # The trained model also owns a parameter-free log-mel frontend. Its
    # non-persistent buffers never appear in model_state, so every learned key
    # must load into this export core.
    if missing or unexpected:
        raise RuntimeError(f'Checkpoint/core mismatch: missing={missing} unexpected={unexpected}')

    output = Path(args.output)
    calibration_output = Path(args.calibration_output)
    output.parent.mkdir(parents=True, exist_ok=True)
    calibration_output.parent.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(1965)
    log_mel = torch.randn(1, 96, 301, dtype=torch.float32)
    rhythm = torch.randn(1, 301, 8, dtype=torch.float32)
    rhythm[..., 6] = torch.sigmoid(rhythm[..., 6])
    rhythm[..., 7] = 1.0

    with torch.inference_mode():
        torch_presence, torch_attack = model(log_mel, rhythm)
        zero_rhythm = torch.zeros_like(rhythm)
        torch_zero_presence, torch_zero_attack = model(log_mel, zero_rhythm)

    torch.onnx.export(
        model,
        (log_mel, rhythm),
        output,
        input_names=['log_mel', 'rhythm'],
        output_names=['presence_logits', 'attack_logits'],
        opset_version=args.opset,
        do_constant_folding=True,
        dynamo=False,
    )

    import onnx
    import onnxruntime as ort

    graph = onnx.load(str(output))
    onnx.checker.check_model(graph)
    if [item.name for item in graph.graph.input] != ['log_mel', 'rhythm']:
        raise RuntimeError('Unexpected ONNX input contract')
    if [item.name for item in graph.graph.output] != ['presence_logits', 'attack_logits']:
        raise RuntimeError('Unexpected ONNX output contract')

    session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
    ort_presence, ort_attack = session.run(None, {'log_mel': log_mel.numpy(), 'rhythm': rhythm.numpy()})
    np.testing.assert_allclose(ort_presence, torch_presence.numpy(), rtol=1e-4, atol=1e-4)
    np.testing.assert_allclose(ort_attack, torch_attack.numpy(), rtol=1e-4, atol=1e-4)
    ort_zero_presence, ort_zero_attack = session.run(None, {'log_mel': log_mel.numpy(), 'rhythm': zero_rhythm.numpy()})
    np.testing.assert_allclose(ort_zero_presence, torch_zero_presence.numpy(), rtol=1e-4, atol=1e-4)
    np.testing.assert_allclose(ort_zero_attack, torch_zero_attack.numpy(), rtol=1e-4, atol=1e-4)

    calibration = {
        'model': 'guitar-ear-v0.2e-rhythm',
        'selected_seed': 29,
        'selection_basis': 'best validation rhythm-conditioned attack F1 among seeds 7,17,29',
        'sample_rate': 16000,
        'window_seconds': 3.0,
        'frames': 301,
        'rhythm_features': 8,
        'presence_frame_threshold': 0.35,
        'presence_segment_threshold': 0.375,
        'attack_threshold': 0.50,
        'attack_threshold_basis': 'seed29 validation threshold sweep',
        'rhythm_feature_order': [
            'sin_pulse_phase', 'cos_pulse_phase', 'sin_slot_phase', 'cos_slot_phase',
            'slot_proximity', 'tempo_norm', 'rhythm_confidence', 'rhythm_available'
        ],
    }
    calibration_output.write_text(json.dumps(calibration, indent=2) + '\n', encoding='utf-8')

    print(f'PHASE2E_EXTENSION_ONNX_OK path={output}')
    print(f'ONNX_SIZE_BYTES={output.stat().st_size}')
    print('INPUTS=log_mel[1,96,301],rhythm[1,301,8]')
    print('OUTPUTS=presence_logits[1,301],attack_logits[1,301]')


if __name__ == '__main__':
    main()
