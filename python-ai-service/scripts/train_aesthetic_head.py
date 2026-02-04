#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
使用 SigLIP embedding + NIMA 分数训练轻量审美回归头，并导出 ONNX。

步骤：
1. 读取 `generate_aesthetic_dataset.py` 生成的 npz 数据集。
2. 划分训练 / 验证 / 测试集。
3. 训练线性或小型 MLP 回归头（输出范围 0~100）。
4. 导出 PyTorch state_dict + ONNX 模型，并写入训练指标报告。

执行示例：
```
python3 scripts/train_aesthetic_head.py \
    --dataset data/aesthetic_dataset/dataset.npz \
    --output-dir data/aesthetic_head \
    --head linear --epochs 12
```
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Subset, TensorDataset

from config import settings
from logger import logger

# =======================
# 数据类与模型定义
# =======================


@dataclass
class DatasetSplits:
    train_indices: List[int]
    val_indices: List[int]
    test_indices: List[int]


class LinearHead(nn.Module):
    def __init__(self, input_dim: int):
        super().__init__()
        self.fc = nn.Linear(input_dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.fc(x)
        return 100.0 * torch.sigmoid(x)


class MLPHead(nn.Module):
    def __init__(self, input_dim: int, hidden_dim: int = 128):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.GELU(),
            nn.Linear(hidden_dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.mlp(x)
        return 100.0 * torch.sigmoid(x)


# =======================
# 工具函数
# =======================


def _set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():  # pragma: no cover - GPU 环境下运行
        torch.cuda.manual_seed_all(seed)


def _resolve_device() -> torch.device:
    if settings.USE_GPU and torch.cuda.is_available():  # pragma: no cover - GPU 环境下运行
        return torch.device("cuda")
    return torch.device("cpu")


def _load_dataset(npz_path: Path) -> Tuple[torch.Tensor, torch.Tensor]:
    data = np.load(npz_path)
    embeddings = torch.from_numpy(data["embeddings"]).float()
    scores = torch.from_numpy(data["scores"]).float().unsqueeze(1)
    return embeddings, scores


def _split_indices(total: int, val_ratio: float, test_ratio: float, seed: int) -> DatasetSplits:
    if total < 10:
        raise ValueError("样本数量过少，无法划分训练/验证/测试集")

    rng = np.random.default_rng(seed)
    indices = np.arange(total)
    rng.shuffle(indices)

    test_size = max(1, int(total * test_ratio))
    val_size = max(1, int(total * val_ratio))
    train_size = total - val_size - test_size
    if train_size <= 0:
        raise ValueError("数据划分比例不合理，训练集为空")

    train_indices = indices[:train_size]
    val_indices = indices[train_size:train_size + val_size]
    test_indices = indices[train_size + val_size:]

    return DatasetSplits(
        train_indices=train_indices.tolist(),
        val_indices=val_indices.tolist(),
        test_indices=test_indices.tolist(),
    )


def _build_model(head: str, input_dim: int, mlp_hidden_dim: int) -> nn.Module:
    if head == "linear":
        return LinearHead(input_dim)
    if head == "mlp":
        return MLPHead(input_dim, hidden_dim=mlp_hidden_dim)
    raise ValueError(f"不支持的 head 类型: {head}")


def _create_dataloaders(
    embeddings: torch.Tensor,
    scores: torch.Tensor,
    splits: DatasetSplits,
    batch_size: int,
) -> Tuple[DataLoader, DataLoader, DataLoader]:
    dataset = TensorDataset(embeddings, scores)
    train_loader = DataLoader(Subset(dataset, splits.train_indices), batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(Subset(dataset, splits.val_indices), batch_size=batch_size, shuffle=False)
    test_loader = DataLoader(Subset(dataset, splits.test_indices), batch_size=batch_size, shuffle=False)
    return train_loader, val_loader, test_loader


def _pearsonr(x: np.ndarray, y: np.ndarray) -> float:
    if x.size < 2 or y.size < 2:
        return float("nan")
    covariance = np.cov(x, y)
    denom = math.sqrt(covariance[0, 0] * covariance[1, 1])
    if denom == 0:
        return float("nan")
    return float(covariance[0, 1] / denom)


def _rankdata(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(len(values), dtype=np.float64)

    unique, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    for idx, count in enumerate(counts):
        if count > 1:
            mask = np.where(inverse == idx)[0]
            mean_rank = ranks[mask].mean()
            ranks[mask] = mean_rank
    return ranks


def _spearmanr(x: np.ndarray, y: np.ndarray) -> float:
    if x.size < 2 or y.size < 2:
        return float("nan")
    rx = _rankdata(x)
    ry = _rankdata(y)
    return _pearsonr(rx, ry)


def _evaluate(model: nn.Module, loader: DataLoader, device: torch.device, loss_fn) -> Tuple[float, torch.Tensor, torch.Tensor]:
    model.eval()
    total_loss = 0.0
    predictions: List[torch.Tensor] = []
    targets: List[torch.Tensor] = []

    with torch.no_grad():
        for embeddings, labels in loader:
            embeddings = embeddings.to(device)
            labels = labels.to(device)
            outputs = model(embeddings)
            loss = loss_fn(outputs, labels)
            total_loss += loss.item() * embeddings.size(0)
            predictions.append(outputs.cpu())
            targets.append(labels.cpu())

    total = len(loader.dataset)
    avg_loss = total_loss / max(total, 1)
    return avg_loss, torch.cat(predictions, dim=0), torch.cat(targets, dim=0)


def _compute_metrics(preds: torch.Tensor, targets: torch.Tensor) -> Dict[str, float]:
    preds_np = preds.squeeze(1).numpy()
    targets_np = targets.squeeze(1).numpy()

    mae = float(np.mean(np.abs(preds_np - targets_np)))
    rmse = float(math.sqrt(np.mean((preds_np - targets_np) ** 2)))
    pearson = _pearsonr(preds_np, targets_np)
    spearman = _spearmanr(preds_np, targets_np)

    return {
        "mae": mae,
        "rmse": rmse,
        "pearson": pearson,
        "spearman": spearman,
    }


def _metrics_meet_target(metrics: Dict[str, float], target_pearson: float, target_spearman: float) -> bool:
    if target_pearson <= 0 and target_spearman <= 0:
        return False

    pearson_ok = target_pearson <= 0 or (not math.isnan(metrics["pearson"]) and metrics["pearson"] >= target_pearson)
    spearman_ok = target_spearman <= 0 or (not math.isnan(metrics["spearman"]) and metrics["spearman"] >= target_spearman)
    return pearson_ok and spearman_ok


def _train_model(
    model: nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    device: torch.device,
    epochs: int,
    lr: float,
    weight_decay: float,
    min_epochs: int,
    target_pearson: float,
    target_spearman: float,
    scheduler_type: str,
    lr_min: float,
) -> Tuple[nn.Module, List[Dict[str, float]]]:
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    loss_fn = nn.SmoothL1Loss()

    history: List[Dict[str, float]] = []
    best_state = None
    best_val_loss = float("inf")

    model.to(device)

    if scheduler_type == "cosine":
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=lr_min)
    else:
        scheduler = None

    for epoch in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        for embeddings, labels in train_loader:
            embeddings = embeddings.to(device)
            labels = labels.to(device)

            optimizer.zero_grad()
            outputs = model(embeddings)
            loss = loss_fn(outputs, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * embeddings.size(0)

        train_loss = total_loss / len(train_loader.dataset)
        val_loss, val_preds, val_targets = _evaluate(model, val_loader, device, loss_fn)
        val_metrics = _compute_metrics(val_preds, val_targets)

        history.append(
            {
                "epoch": epoch,
                "train_loss": train_loss,
                "val_loss": val_loss,
                "val_mae": val_metrics["mae"],
                "val_rmse": val_metrics["rmse"],
                "val_pearson": val_metrics["pearson"],
                "val_spearman": val_metrics["spearman"],
                "lr": optimizer.param_groups[0]["lr"],
            }
        )
        logger.info(
            "训练进度",
            details={
                "epoch": epoch,
                "train_loss": f"{train_loss:.4f}",
                "val_loss": f"{val_loss:.4f}",
                "val_pearson": f"{val_metrics['pearson']:.4f}",
                "val_spearman": f"{val_metrics['spearman']:.4f}",
                "lr": f"{optimizer.param_groups[0]['lr']:.6f}",
            },
        )

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

        if epoch >= min_epochs and _metrics_meet_target(val_metrics, target_pearson, target_spearman):
            logger.info(
                "达到目标指标，提前停止训练",
                details={
                    "epoch": epoch,
                    "target_pearson": target_pearson,
                    "target_spearman": target_spearman,
                    "val_pearson": f"{val_metrics['pearson']:.4f}",
                    "val_spearman": f"{val_metrics['spearman']:.4f}",
                },
            )
            break

        if scheduler is not None:
            scheduler.step()

    if best_state is not None:
        model.load_state_dict(best_state)
    model.to(device)
    return model, history


def _export_artifacts(
    model: nn.Module,
    output_dir: Path,
    input_dim: int,
    metrics: Dict[str, Dict[str, float]],
    history: List[Dict[str, float]],
    args: argparse.Namespace,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    model.eval()
    cpu_model = model.cpu()

    pt_path = output_dir / "aesthetic_head.pt"
    torch.save(cpu_model.state_dict(), pt_path)

    onnx_path = output_dir / "siglip_aesthetic_head.onnx"
    dummy = torch.randn(1, input_dim, dtype=torch.float32)
    torch.onnx.export(
        cpu_model,
        dummy,
        str(onnx_path),
        input_names=["embedding"],
        output_names=["score"],
        dynamic_axes={"embedding": {0: "batch"}, "score": {0: "batch"}},
        opset_version=17,
    )

    report = {
        "head": args.head,
        "input_dim": input_dim,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "learning_rate": args.lr,
        "lr_scheduler": args.lr_scheduler,
        "lr_min": args.lr_min,
        "weight_decay": args.weight_decay,
        "metrics": metrics,
        "history": history,
    }

    report_path = output_dir / "training_report.json"
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    logger.info(
        "模型导出完成",
        details={
            "state_dict": str(pt_path),
            "onnx": str(onnx_path),
            "report": str(report_path),
        },
    )


# =======================
# 主执行逻辑
# =======================


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="训练 SigLIP 审美回归头")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "aesthetic_dataset" / "dataset.npz",
        help="输入数据集 npz 路径",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "aesthetic_head",
        help="输出目录（保存 ONNX 与报告）",
    )
    parser.add_argument(
        "--head",
        choices=["linear", "mlp"],
        default="linear",
        help="回归头类型",
    )
    parser.add_argument("--mlp-hidden-dim", type=int, default=128, help="MLP 头的隐藏层宽度（head=mlp 时生效）")
    parser.add_argument("--epochs", type=int, default=10, help="训练轮数")
    parser.add_argument("--min-epochs", type=int, default=10, help="最少训练轮数（用于早停）")
    parser.add_argument("--batch-size", type=int, default=256, help="批大小")
    parser.add_argument("--lr", type=float, default=1e-3, help="学习率")
    parser.add_argument(
        "--lr-scheduler",
        choices=["none", "cosine"],
        default="none",
        help="学习率调度策略",
    )
    parser.add_argument("--lr-min", type=float, default=1e-5, help="调度器的最小学习率（cosine 时生效）")
    parser.add_argument("--weight-decay", type=float, default=1e-4, help="权重衰减")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="验证集占比")
    parser.add_argument("--test-ratio", type=float, default=0.1, help="测试集占比")
    parser.add_argument("--target-pearson", type=float, default=0.6, help="验证集 Pearson 目标，<=0 表示不启用")
    parser.add_argument("--target-spearman", type=float, default=0.6, help="验证集 Spearman 目标，<=0 表示不启用")
    parser.add_argument("--seed", type=int, default=42, help="随机种子")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = parse_args(argv)

    if args.min_epochs > args.epochs:
        raise ValueError("min-epochs 不可大于 epochs")

    if not args.dataset.exists():
        raise FileNotFoundError(f"数据集文件不存在: {args.dataset}")

    _set_seed(args.seed)
    device = _resolve_device()

    embeddings, scores = _load_dataset(args.dataset)
    total = embeddings.size(0)
    logger.info("加载数据集", details={"samples": total, "input_dim": embeddings.size(1)})

    splits = _split_indices(total, args.val_ratio, args.test_ratio, args.seed)
    train_loader, val_loader, test_loader = _create_dataloaders(embeddings, scores, splits, args.batch_size)

    model = _build_model(args.head, embeddings.size(1), args.mlp_hidden_dim)
    model, history = _train_model(
        model,
        train_loader,
        val_loader,
        device,
        args.epochs,
        args.lr,
        args.weight_decay,
        args.min_epochs,
        args.target_pearson,
        args.target_spearman,
        args.lr_scheduler,
        args.lr_min,
    )

    loss_fn = nn.SmoothL1Loss()
    train_loss, train_preds, train_targets = _evaluate(model, train_loader, device, loss_fn)
    val_loss, val_preds, val_targets = _evaluate(model, val_loader, device, loss_fn)
    test_loss, test_preds, test_targets = _evaluate(model, test_loader, device, loss_fn)

    metrics = {
        "train": {"loss": train_loss, **_compute_metrics(train_preds, train_targets)},
        "val": {"loss": val_loss, **_compute_metrics(val_preds, val_targets)},
        "test": {"loss": test_loss, **_compute_metrics(test_preds, test_targets)},
        "sizes": {
            "train": len(splits.train_indices),
            "val": len(splits.val_indices),
            "test": len(splits.test_indices),
        },
    }

    logger.info("训练完成", details={"train_loss": f"{train_loss:.4f}", "val_loss": f"{val_loss:.4f}", "test_loss": f"{test_loss:.4f}"})

    _export_artifacts(model, args.output_dir, embeddings.size(1), metrics, history, args)


if __name__ == "__main__":
    main()
