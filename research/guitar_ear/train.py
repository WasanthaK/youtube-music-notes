from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from data import GuitarEarDataset
from model import GuitarEar


def focal_bce_with_logits(
    logits: torch.Tensor,
    targets: torch.Tensor,
    alpha: float = 0.75,
    gamma: float = 2.0,
) -> torch.Tensor:
    bce = F.binary_cross_entropy_with_logits(logits, targets, reduction='none')
    probs = torch.sigmoid(logits)
    pt = targets * probs + (1.0 - targets) * (1.0 - probs)
    alpha_t = targets * alpha + (1.0 - targets) * (1.0 - alpha)
    return (alpha_t * (1.0 - pt).pow(gamma) * bce).mean()


@torch.no_grad()
def metrics(logits: torch.Tensor, targets: torch.Tensor, threshold: float = 0.5) -> dict[str, float]:
    pred = torch.sigmoid(logits) >= threshold
    truth = targets >= 0.5
    tp = (pred & truth).sum().item()
    fp = (pred & ~truth).sum().item()
    fn = (~pred & truth).sum().item()
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-12)
    return {'precision': precision, 'recall': recall, 'f1': f1}


def run_epoch(model, loader, optimizer, device, training: bool) -> dict[str, float]:
    model.train(training)
    total_loss = 0.0
    batches = 0
    presence_logits_all = []
    presence_targets_all = []
    attack_logits_all = []
    attack_targets_all = []

    for batch in loader:
        waveform = batch['waveform'].to(device)
        presence = batch['presence'].to(device)
        attack = batch['attack'].to(device)

        with torch.set_grad_enabled(training):
            out = model(waveform)
            min_frames = min(
                out['presence_logits'].shape[1],
                presence.shape[1],
                attack.shape[1],
            )
            p_logits = out['presence_logits'][:, :min_frames]
            a_logits = out['attack_logits'][:, :min_frames]
            p_target = presence[:, :min_frames]
            a_target = attack[:, :min_frames]

            presence_loss = F.binary_cross_entropy_with_logits(p_logits, p_target)
            attack_loss = focal_bce_with_logits(a_logits, a_target)
            loss = presence_loss + 2.0 * attack_loss

            if training:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                optimizer.step()

        total_loss += float(loss.detach().cpu())
        batches += 1
        presence_logits_all.append(p_logits.detach().cpu())
        presence_targets_all.append(p_target.detach().cpu())
        attack_logits_all.append(a_logits.detach().cpu())
        attack_targets_all.append(a_target.detach().cpu())

    p = metrics(torch.cat(presence_logits_all), torch.cat(presence_targets_all))
    a = metrics(torch.cat(attack_logits_all), torch.cat(attack_targets_all))
    return {
        'loss': total_loss / max(batches, 1),
        'presence_f1': p['f1'],
        'presence_precision': p['precision'],
        'presence_recall': p['recall'],
        'attack_f1': a['f1'],
        'attack_precision': a['precision'],
        'attack_recall': a['recall'],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--batch-size', type=int, default=24)
    parser.add_argument('--lr', type=float, default=3e-4)
    parser.add_argument('--crop-seconds', type=float, default=3.0)
    parser.add_argument('--out', default='checkpoints/guitar-ear-v0.1.pt')
    args = parser.parse_args()

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'device={device}')

    train_ds = GuitarEarDataset(args.manifest, 'train', crop_seconds=args.crop_seconds, training=True)
    val_ds = GuitarEarDataset(args.manifest, 'val', crop_seconds=args.crop_seconds, training=False)
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=0)

    model = GuitarEar().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    best = -1.0

    for epoch in range(1, args.epochs + 1):
        train_stats = run_epoch(model, train_loader, optimizer, device, training=True)
        val_stats = run_epoch(model, val_loader, optimizer, device, training=False)
        score = 0.45 * val_stats['presence_f1'] + 0.55 * val_stats['attack_f1']
        print(json.dumps({'epoch': epoch, 'train': train_stats, 'val': val_stats, 'score': score}))

        if score > best:
            best = score
            torch.save(
                {
                    'model_state': model.state_dict(),
                    'sample_rate': 16000,
                    'hop_seconds': model.hop_seconds,
                    'best_score': best,
                },
                out_path,
            )
            print(f'saved {out_path} score={best:.4f}')


if __name__ == '__main__':
    main()
