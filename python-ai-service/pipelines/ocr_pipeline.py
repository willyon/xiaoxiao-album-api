#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 流程：拿引擎 → recognize（内部 resize + bbox 回原图）→ 返回 blocks
"""

from __future__ import annotations

from typing import Any

import numpy as np

from config import settings
from logger import logger
from utils.timeout import run_with_timeout


def analyze_ocr(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
) -> dict:
    """
    执行 OCR。无引擎时返回 { "blocks": [] }。
    返回格式: { "blocks": [ { "text", "bbox", "confidence" } ] }，bbox 为原图坐标。
    """
    engine = model_manager.get_ocr_engine(profile, device) if model_manager else None
    if engine is None:
        return {"blocks": []}
    try:
        timeout = getattr(settings, "OCR_TIMEOUT_SECONDS", 20.0)
        blocks = run_with_timeout(engine.recognize, timeout, image)
        return {"blocks": blocks}
    except Exception as e:
        logger.warning("ocr_pipeline 推理失败: %s", e)
        return {"blocks": []}
