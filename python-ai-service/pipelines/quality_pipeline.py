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


def analyze_quality(
    image_bgr: np.ndarray,
    device: str,
    manager: Any,
    embedding: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    质量分析入口（由 analyze_image 编排的 quality 模块调用）。
    返回 hashes、sharpness_score；美学分仅当传入与 embedding 模块同结构的 vector 时计算。
    """
    if image_bgr is None:
        logger.warning("analyze_quality: 收到空图像，返回空结果")
        return {
            "hashes": {},
            "aesthetic_score": 0.0,
            "sharpness_score": 0.0,
        }

    try:
        model = manager.get_quality_model(device) if manager else None
        if model is None:
            logger.warning("analyze_quality: 未获取到 QualityAnalyzer，返回空结果")
            return {
                "hashes": {},
                "aesthetic_score": 0.0,
                "sharpness_score": 0.0,
            }
        return model.analyze(
            image_bgr=image_bgr,
            device=device,
            embedding=embedding,
        )
    except Exception as exc:  # pragma: no cover
        logger.error("analyze_quality 处理失败", details={"error": str(exc)})
        raise

