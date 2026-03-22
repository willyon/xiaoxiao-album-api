#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片质量指标 pipeline
- 输入：统一解码后的 BGR 图像 + device + ModelManager
- 通过 ModelManager 获取 QualityAnalyzer，由 quality_analysis_service 提供具体实现
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import numpy as np

from logger import logger


def analyze_cleanup(
    image_bgr: np.ndarray,
    device: str,
    manager: Any,
    precomputed_embedding: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    质量分析入口（对外 API：POST /analyze_quality）。
    仅返回 hashes、aesthetic_score、sharpness_score。
    """
    if image_bgr is None:
        logger.warning("analyze_cleanup: 收到空图像，返回空结果")
        return {
            "hashes": {},
            "aesthetic_score": 0.0,
            "sharpness_score": 0.0,
        }

    try:
        model = manager.get_quality_model(device) if manager else None
        if model is None:
            logger.warning("analyze_cleanup: 未获取到 QualityAnalyzer，返回空结果")
            return {
                "hashes": {},
                "aesthetic_score": 0.0,
                "sharpness_score": 0.0,
            }
        return model.analyze(
            image_bgr=image_bgr,
            device=device,
            precomputed_embedding=precomputed_embedding,
        )
    except Exception as exc:  # pragma: no cover
        logger.error("analyze_cleanup 处理失败", details={"error": str(exc)})
        raise

