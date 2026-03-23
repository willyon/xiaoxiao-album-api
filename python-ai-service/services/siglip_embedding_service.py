#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SigLIP2 图像向量服务
--------------------
- 提供 compute_siglip_embedding(rgb_image)，供 embedding 模块、scene_model 等使用（美学分由 analyze_image 编排传入向量，不在此重复计算）
- 通过模型注册表按 task_type='image_embedding' 解析 model_id，支持 fallback
"""

from __future__ import annotations

from typing import Dict, Optional

import numpy as np
from PIL import Image

from config import settings
from logger import logger
from loaders.model_loader import get_siglip2_components_for_path
from services.model_registry import get_fallback_model_id, get_model_config, resolve_local_path, resolve_model_id


def compute_siglip_embedding(rgb_image: np.ndarray) -> Optional[Dict[str, object]]:
    """
    计算 SigLIP 图像向量，成功时返回 {"vector": [...]}。

    逻辑：
    - 通过模型注册表按 task_type='image_embedding' 解析出首选 model_id；
    - 若对应目录加载失败且存在 fallback_model_id，则自动回退；
    - SigLIP2 目录结构：{local_path}/siglip2_image_encoder.onnx 等。
    """
    # 1. 解析主模型与 fallback
    primary_id = resolve_model_id("image_embedding")
    candidate_ids = []
    if primary_id:
        candidate_ids.append(primary_id)
        fb = get_fallback_model_id(primary_id)
        if fb and fb not in candidate_ids:
            candidate_ids.append(fb)

    # 兜底：若注册表未配置 image_embedding 主模型
    if not candidate_ids:
        candidate_ids = ["embedding.standard.siglip2.base"]

    providers = settings.get_onnx_providers()

    last_error: Optional[Exception] = None
    for model_id in candidate_ids:
        cfg = get_model_config(model_id)
        if not cfg:
            continue
        try:
            image_session, _, _, metadata = get_siglip2_components_for_path(
                resolve_local_path(cfg.local_path),
                providers=providers,
                raise_on_failure=False,
            )
            if image_session is None or metadata is None:
                continue

            pixel_values = _prepare_siglip_pixel_values(rgb_image, metadata)
            if pixel_values is None:
                continue

            input_name = image_session.get_inputs()[0].name
            outputs = image_session.run(None, {input_name: pixel_values})
            if not outputs:
                continue

            # 输出 1152 维；编码器可能有两路输出（patch 特征 + select_2），取展平后长度为 1152 的那一路。
            EXPECTED_EMBED_DIM = 1152
            vector = None
            for out in outputs:
                arr = np.asarray(out).astype(np.float32).flatten()
                if arr.size == EXPECTED_EMBED_DIM:
                    vector = arr
                    break
            if vector is None:
                got = int(np.asarray(outputs[0]).size)
                logger.warning(
                    "SigLIP2 图像编码器未找到 1152 维输出，首输出为 %s 维，跳过本模型" % got,
                    details={"expected": EXPECTED_EMBED_DIM, "got": got},
                )
                continue
            norm = np.linalg.norm(vector)
            if norm > 0:
                vector = vector / norm

            return {"vector": vector.tolist()}
        except Exception as exc:  # pragma: no cover
            last_error = exc
            logger.warning(
                "SigLIP2 向量计算失败，将尝试 fallback（若有）",
                details={"error": str(exc), "model_id": model_id},
            )

    if last_error:
        logger.error(
            "SigLIP2 向量计算所有候选模型均失败",
            details={"error": str(last_error), "candidates": candidate_ids},
        )
    return None


def _prepare_siglip_pixel_values(rgb_image: np.ndarray, metadata: Dict[str, object]) -> Optional[np.ndarray]:
    """按 metadata.json 要求执行 resize/center-crop/归一化，返回 ONNX 输入张量。"""
    try:
        image = Image.fromarray(rgb_image)
    except Exception as exc:  # pragma: no cover
        logger.error("SigLIP2 预处理失败：无法构建 PIL 图像", details={"error": str(exc)})
        return None

    resample = _resolve_resample(metadata.get("resample"))
    size_cfg = metadata.get("size") or {}
    crop_cfg = metadata.get("crop_size") or {}

    if metadata.get("do_resize", True) and isinstance(size_cfg, dict):
        if "shortest_edge" in size_cfg:
            target = int(size_cfg["shortest_edge"])
            image = _resize_to_shorter_edge(image, target, resample=resample)
        elif "height" in size_cfg and "width" in size_cfg:
            target_size = (int(size_cfg["width"]), int(size_cfg["height"]))
            image = image.resize(target_size, resample=resample)

    if metadata.get("do_center_crop", True) and isinstance(crop_cfg, dict):
        target_height = int(crop_cfg.get("height", crop_cfg.get("shortest_edge", image.height)))
        target_width = int(crop_cfg.get("width", crop_cfg.get("shortest_edge", image.width)))
        image = _center_crop(image, target_height, target_width)

    image_array = np.asarray(image).astype(np.float32) / 255.0
    mean = np.array(metadata.get("image_mean", [0.5, 0.5, 0.5]), dtype=np.float32)
    std = np.array(metadata.get("image_std", [0.5, 0.5, 0.5]), dtype=np.float32)
    image_array = (image_array - mean) / std
    image_array = np.transpose(image_array, (2, 0, 1))
    return np.expand_dims(image_array.astype(np.float32), axis=0)


def _resolve_resample(value) -> int:
    if value is None:
        return Image.BICUBIC
    try:
        return int(value)
    except Exception:  # pragma: no cover
        return Image.BICUBIC


def _resize_to_shorter_edge(image: Image.Image, target: int, *, resample: int) -> Image.Image:
    width, height = image.size
    if min(width, height) == target:
        return image

    if width < height:
        new_width = target
        new_height = int(round(height * target / width))
    else:
        new_height = target
        new_width = int(round(width * target / height))
    return image.resize((new_width, new_height), resample=resample)


def _center_crop(image: Image.Image, target_height: int, target_width: int) -> Image.Image:
    width, height = image.size
    left = max(0, int(round((width - target_width) / 2)))
    top = max(0, int(round((height - target_height) / 2)))
    right = left + target_width
    bottom = top + target_height
    return image.crop((left, top, right, bottom))


__all__ = ["compute_siglip_embedding"]
