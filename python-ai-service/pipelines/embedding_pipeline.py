#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Embedding 流程：
- 图像向量：使用 SigLIP2 image encoder（与现有 1152 维向量保持一致）
"""

from __future__ import annotations

from typing import Any, Dict

import numpy as np

from logger import logger


def encode_image_for_search(
    image_bgr: np.ndarray,  # type: ignore[name-defined]
    device: str,
    model_manager: Any,
) -> Dict[str, Any]:
    """
    生成用于搜索/相似图检索的图像向量。
    返回: { "vector": [...] } 或空结构（由底层 encode 决定）。
    """
    bundle = model_manager.get_embedding_model(device) if model_manager else None
    if bundle is None or getattr(bundle, "image_model", None) is None:
        return {}
    try:
        payload = bundle.image_model.encode_image(image_bgr)
        return payload or {}
    except Exception as exc:
        logger.warning("encode_image_for_search 失败: %s" % exc)
        return {}

