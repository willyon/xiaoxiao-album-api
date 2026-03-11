#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Embedding 流程：
- 图像向量：使用 SigLIP2 image encoder（与现有 1152 维向量保持一致）
- 文本向量（BGE-M3 骨架）：预留统一文本检索向量接口
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import numpy as np

from logger import logger


def encode_image_for_search(
    image_bgr: np.ndarray,  # type: ignore[name-defined]
    profile: str,
    device: str,
    model_manager: Any,
) -> Dict[str, Any]:
    """
    生成用于搜索/相似图检索的图像向量。
    返回: { "vector": [...], "model": "siglip2" } 或空结构。
    """
    bundle = model_manager.get_embedding_model(profile, device) if model_manager else None
    if bundle is None or getattr(bundle, "image_model", None) is None:
        return {}
    try:
        payload = bundle.image_model.encode_image(image_bgr)
        return payload or {}
    except Exception as exc:
        logger.warning("encode_image_for_search 失败: %s", exc)
        return {}


def encode_text_for_search(
    text: str,
    profile: str,
    device: str,
    model_manager: Any,
) -> Dict[str, Any]:
    """
    生成用于统一语义搜索的文本向量（BGE-M3 骨架）。

    说明：
    - 当前不会替换现有 SigLIP2 1152 维 encode_text 接口，以避免与已有向量索引/存储维度冲突
    - 后续可以在 Node/索引迁移完成后，将该能力真正接入搜索主链路
    """
    bundle = model_manager.get_embedding_model(profile, device) if model_manager else None
    if bundle is None or getattr(bundle, "text_model", None) is None:
        return {}
    try:
        payload = bundle.text_model.encode_text(text)  # type: ignore[union-attr]
        return payload or {}
    except Exception as exc:
        logger.warning("encode_text_for_search 失败: %s", exc)
        return {}

