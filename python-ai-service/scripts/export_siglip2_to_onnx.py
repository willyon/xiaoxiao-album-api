#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SigLIP2 模型导出脚本
--------------------
将指定的 SigLIP2 多模态模型导出为独立的图像编码器与文本编码器 ONNX 文件，
并保存对应的 SentencePiece 分词器与图像预处理配置，方便在无 PyTorch 环境的
服务端直接加载推理。

使用示例:
    python3 scripts/export_siglip2_to_onnx.py \\
        --model-id google/siglip2-so400m-patch14-384 \\
        --output-dir models/siglip2 \\
        --cpu-only
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, Tuple

import torch
from transformers import (
    AutoConfig,
    SiglipModel,
    SiglipProcessor,
    SiglipTokenizer,
)


def _resolve_device(force_cpu: bool = False) -> torch.device:
    if force_cpu:
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _prepare_dummy_inputs(processor: SiglipProcessor) -> Tuple[torch.Tensor, Dict[str, torch.Tensor]]:
    image_processor = processor.image_processor
    tokenizer = processor.tokenizer

    crop_size = getattr(image_processor, "crop_size", None)
    size_cfg = crop_size or getattr(image_processor, "size", {}) or {}
    if isinstance(size_cfg, dict):
        height = size_cfg.get("height") or size_cfg.get("shortest_edge") or size_cfg.get("width") or 384
        width = size_cfg.get("width") or size_cfg.get("shortest_edge") or size_cfg.get("height") or 384
    elif isinstance(size_cfg, int):
        height = width = size_cfg
    else:
        height = width = 384

    pixel_values = torch.randn(1, 3, height, width, dtype=torch.float32)

    model_max_length = getattr(tokenizer, "model_max_length", None)
    if isinstance(model_max_length, int) and 0 < model_max_length < 1_000_000_000:
        pad_strategy = "max_length"
    else:
        pad_strategy = "longest"
        model_max_length = None

    tokenizer_kwargs = {
        "padding": pad_strategy,
        "truncation": True,
        "return_attention_mask": True,
        "return_tensors": "pt",
    }
    if model_max_length is not None:
        tokenizer_kwargs["max_length"] = model_max_length

    token_inputs = tokenizer(["export dummy sentence"], **tokenizer_kwargs)
    attention_mask = token_inputs.get("attention_mask")
    if attention_mask is None:
        attention_mask = torch.ones_like(token_inputs["input_ids"])
    return pixel_values, {"input_ids": token_inputs["input_ids"], "attention_mask": attention_mask}


class _SiglipImageEncoder(torch.nn.Module):
    def __init__(self, model: SiglipModel):
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:  # type: ignore[override]
        return self.model.get_image_features(pixel_values=pixel_values)


class _SiglipTextEncoder(torch.nn.Module):
    def __init__(self, model: SiglipModel):
        super().__init__()
        self.model = model

    def forward(  # type: ignore[override]
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
    ) -> torch.Tensor:
        return self.model.get_text_features(
            input_ids=input_ids,
            attention_mask=attention_mask,
        )


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _save_metadata(
    output_dir: Path,
    *,
    model_id: str,
    config: AutoConfig,
    processor: SiglipProcessor,
) -> None:
    image_processor = processor.image_processor
    tokenizer = processor.tokenizer

    hidden_size = getattr(config, "projection_dim", None)
    if hidden_size is None:
        text_config = getattr(config, "text_config", None)
        hidden_size = getattr(text_config, "hidden_size", None) if text_config is not None else None
    if hidden_size is None:
        hidden_size = getattr(config, "hidden_size", None)

    metadata = {
        "model_id": model_id,
        "hidden_size": hidden_size,
        "image_mean": list(image_processor.image_mean),
        "image_std": list(image_processor.image_std),
        "resample": int(image_processor.resample),
        "do_resize": bool(image_processor.do_resize),
        "do_center_crop": bool(getattr(image_processor, "do_center_crop", getattr(image_processor, "center_crop", False))),
        "size": getattr(image_processor, "size", None),
        "crop_size": getattr(image_processor, "crop_size", getattr(image_processor, "size", None)),
        "max_sequence_length": int(tokenizer.model_max_length),
        "padding_side": tokenizer.padding_side,
        "bos_token_id": tokenizer.bos_token_id,
        "eos_token_id": tokenizer.eos_token_id,
        "pad_token_id": tokenizer.pad_token_id,
    }

    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False))


def export_siglip2(
    *,
    model_id: str,
    output_dir: Path,
    force_cpu: bool,
) -> None:
    device = _resolve_device(force_cpu=force_cpu)
    print(f"[INFO] 加载模型 {model_id} 到 {device} ...")

    model = SiglipModel.from_pretrained(model_id, dtype=torch.float32, device_map=None)
    model.to(device)
    model.eval()

    processor = SiglipProcessor.from_pretrained(model_id)
    tokenizer: SiglipTokenizer = processor.tokenizer  # type: ignore[assignment]
    config = AutoConfig.from_pretrained(model_id)

    pixel_values, text_inputs = _prepare_dummy_inputs(processor)
    pixel_values = pixel_values.to(device)
    text_inputs = {k: v.to(device) for k, v in text_inputs.items()}

    image_encoder = _SiglipImageEncoder(model).to(device)
    text_encoder = _SiglipTextEncoder(model).to(device)

    _ensure_dir(output_dir)

    image_path = output_dir / "siglip2_image_encoder.onnx"
    text_path = output_dir / "siglip2_text_encoder.onnx"

    print(f"[INFO] 导出图像编码器 -> {image_path}")
    torch.onnx.export(
        image_encoder,
        pixel_values,
        image_path.as_posix(),
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        opset_version=18,
        dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
        do_constant_folding=True,
    )

    print(f"[INFO] 导出文本编码器 -> {text_path}")
    torch.onnx.export(
        text_encoder,
        (text_inputs["input_ids"], text_inputs["attention_mask"]),
        text_path.as_posix(),
        input_names=["input_ids", "attention_mask"],
        output_names=["text_embeds"],
        opset_version=18,
        dynamic_axes={
            "input_ids": {0: "batch"},
            "attention_mask": {0: "batch"},
            "text_embeds": {0: "batch"},
        },
        do_constant_folding=True,
    )

    print("[INFO] 保存 Tokenizer 文件")
    tokenizer.save_pretrained(output_dir.as_posix())

    print("[INFO] 写入元信息 metadata.json")
    _save_metadata(output_dir, model_id=model_id, config=config, processor=processor)

    print("[DONE] SigLIP2 导出完成")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导出 SigLIP2 模型为 ONNX")
    parser.add_argument(
        "--model-id",
        default="google/siglip2-so400m-patch14-384",
        help="Hugging Face 上的模型 ID（默认：google/siglip2-so400m-patch14-384）",
    )
    parser.add_argument(
        "--output-dir",
        default="models/siglip2",
        help="导出文件输出目录",
    )
    parser.add_argument(
        "--cpu-only",
        action="store_true",
        help="强制使用 CPU 导出",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    export_siglip2(
        model_id=args.model_id,
        output_dir=Path(args.output_dir),
        force_cpu=args.cpu_only,
    )


if __name__ == "__main__":
    main()

