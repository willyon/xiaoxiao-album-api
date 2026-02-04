#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenCLIP 模型导出脚本

用途：
    将指定的 OpenCLIP 视觉 Transformer 变体（ViT-B-32 / ViT-L-14 / ViT-H-14）
    导出为 ONNX 形式的图像编码器与文本编码器，方便在无 PyTorch 环境中做推理。

使用示例：
    python3 scripts/export_openclip_to_onnx.py --output-dir ./models/openclip_onnx
    python3 scripts/export_openclip_to_onnx.py --models ViT-B-32 ViT-L-14

注意事项：
    1. 需提前安装 torch>=2.0 与 open_clip_torch。
    2. 首次运行会联网下载对应的预训练权重，或从 OPEN_CLIP_CACHE_DIR 中读取。
    3. 导出的文件命名为：
        - {alias}_image_encoder.onnx
        - {alias}_text_encoder.onnx
    4. 请在导出后使用 onnxruntime 校验输出是否与 PyTorch 对齐。
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Dict, Tuple

import torch

# open_clip 导入在安装 open_clip_torch 后才可用
import open_clip  # type: ignore


MODEL_CONFIGS: Dict[str, Dict[str, str]] = {
    # OpenAI 官方权重（轻量，推荐起步使用）
    "ViT-B-32": {"pretrained": "openai", "alias": "vit_b_32"},
    # OpenAI 官方权重（精度更高，资源消耗适中）
    "ViT-L-14": {"pretrained": "openai", "alias": "vit_l_14"},
    # OpenCLIP 社区训练（需要更高显存/算力）
    "ViT-H-14": {"pretrained": "laion2b_s32b_b79k", "alias": "vit_h_14"},
}


class _ImageEncoderWrapper(torch.nn.Module):
    """封装 CLIP 图像编码流程便于导出 ONNX"""

    def __init__(self, clip_model: torch.nn.Module):
        super().__init__()
        self.clip_model = clip_model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:  # type: ignore[override]
        return self.clip_model.encode_image(pixel_values)


class _TextEncoderWrapper(torch.nn.Module):
    """封装 CLIP 文本编码流程便于导出 ONNX"""

    def __init__(self, clip_model: torch.nn.Module):
        super().__init__()
        self.clip_model = clip_model

    def forward(self, input_tokens: torch.Tensor) -> torch.Tensor:  # type: ignore[override]
        return self.clip_model.encode_text(input_tokens)


def _resolve_device(force_cpu: bool = False) -> torch.device:
    if force_cpu:
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _create_dummy_inputs(model: torch.nn.Module, device: torch.device) -> Tuple[torch.Tensor, torch.Tensor]:
    """根据模型自动推断图像尺寸并创建示例输入"""
    image_size = getattr(model.visual, "image_size", 224)
    if isinstance(image_size, (tuple, list)):
        height, width = image_size
    else:
        height = width = int(image_size)

    pixel_values = torch.randn(1, 3, height, width, device=device, dtype=torch.float32)
    context_length = getattr(model, "context_length", 77)
    input_tokens = open_clip.tokenize(["export dummy"], context_length=context_length).to(device)  # type: ignore[attr-defined]
    return pixel_values, input_tokens


def export_model(
    model_name: str,
    pretrained: str,
    output_dir: Path,
    *,
    force_cpu: bool,
) -> None:
    device = _resolve_device(force_cpu=force_cpu)
    print(f"[INFO] Loading {model_name} ({pretrained}) on {device} ...")

    clip_model, _, _ = open_clip.create_model_and_transforms(  # type: ignore[attr-defined]
        model_name,
        pretrained=pretrained,
        device=device,
    )
    clip_model.eval()

    pixel_values, input_tokens = _create_dummy_inputs(clip_model, device)

    image_wrapper = _ImageEncoderWrapper(clip_model)
    text_wrapper = _TextEncoderWrapper(clip_model)

    alias = MODEL_CONFIGS[model_name]["alias"]
    image_path = output_dir / f"{alias}_image_encoder.onnx"
    text_path = output_dir / f"{alias}_text_encoder.onnx"

    print(f"[INFO] Exporting image encoder -> {image_path}")
    torch.onnx.export(
        image_wrapper,
        pixel_values,
        image_path.as_posix(),
        opset_version=18,
        input_names=["pixel_values"],
        output_names=["image_features"],
        do_constant_folding=True,
    )

    print(f"[INFO] Exporting text encoder -> {text_path}")
    torch.onnx.export(
        text_wrapper,
        input_tokens,
        text_path.as_posix(),
        opset_version=18,
        input_names=["input_tokens"],
        output_names=["text_features"],
        do_constant_folding=True,
    )

    print(f"[DONE] {model_name} 导出完成\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将 OpenCLIP 模型导出为 ONNX")
    parser.add_argument(
        "--models",
        nargs="+",
        default=list(MODEL_CONFIGS.keys()),
        choices=list(MODEL_CONFIGS.keys()),
        help="需要导出的模型名称，可多选（默认导出全部）",
    )
    parser.add_argument(
        "--output-dir",
        default="models/openclip",
        help="ONNX 文件输出目录",
    )
    parser.add_argument(
        "--cpu-only",
        action="store_true",
        help="强制使用 CPU 导出（避免 CUDA 未安装时报错）",
    )
    return parser.parse_args()


def ensure_output_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def main() -> None:
    args = parse_args()
    output_dir = ensure_output_dir(Path(args.output_dir))

    for model_name in args.models:
        config = MODEL_CONFIGS[model_name]
        export_model(
            model_name,
            config["pretrained"],
            output_dir,
            force_cpu=args.cpu_only,
        )

    print("[INFO] 所有模型导出完成。请使用 onnxruntime 进行校验。")


if __name__ == "__main__":
    main()

