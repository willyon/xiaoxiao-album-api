#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片清理指标 pipeline
- 输入：统一解码后的 BGR 图像 + profile + device + ModelManager
- 目前复用 cleanup_analysis_service.analyze_image，后续可迁移到 models/cleanup_model.py
"""

from __future__ import annotations

from typing import Any, Dict, Optional, List

import numpy as np

from logger import logger


def analyze_cleanup(
    image_bgr: np.ndarray,
    profile: str,
    device: str,
    manager: Any,
    existing_embedding: Optional[List[float]] = None,
    embedding_model: str = "siglip2",
) -> Dict[str, Any]:
    """
    清理分析入口。

    新版：
    - 通过 ModelManager 获取 CleanupAnalyzer 实例
    - 由模型类负责 hashes / aesthetic_score / embedding / sharpness_score 的具体实现
    """
    if image_bgr is None:
        logger.warning("analyze_cleanup: 收到空图像，返回空结果")
        return {
            "hashes": {},
            "aesthetic_score": 0.0,
            "embedding": None,
            "sharpness_score": 0.0,
        }

    try:
        model = manager.get_cleanup_model(profile, device) if manager else None
        if model is None:
            logger.warning("analyze_cleanup: 未获取到 CleanupAnalyzer，返回空结果")
            return {
                "hashes": {},
                "aesthetic_score": 0.0,
                "embedding": None,
                "sharpness_score": 0.0,
            }
        return model.analyze(
            image_bgr=image_bgr,
            profile=profile,
            device=device,
            existing_embedding=existing_embedding,
            embedding_model=embedding_model,
        )
    except Exception as exc:  # pragma: no cover
        logger.error("analyze_cleanup 处理失败", details={"error": str(exc)})
        raise

