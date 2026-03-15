#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
物体检测流程：拿模型 → detect → 过滤置信度、归一化 bbox → 返回统一结构
"""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

from config import settings
from logger import logger
from utils.timeout import run_with_timeout


def analyze_objects(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
) -> dict:
    """
    执行物体检测。无模型时返回 { "objects": [] }。
    返回格式: { "objects": [ { "label", "confidence", "bbox" } ] }，label 为 Raw Label（英文）。
    """
    model = model_manager.get_object_model(profile, device) if model_manager else None
    if model is None:
        return {"objects": []}
    try:
        timeout = getattr(settings, "OBJECT_TIMEOUT_SECONDS", 20.0)
        raw = run_with_timeout(model.detect, timeout, image)
        if not raw:
            return {"objects": []}
        threshold = getattr(settings, "YOLO_CONF_THRESHOLD", 0.25)
        out = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            conf = item.get("confidence", 0.0)
            if conf < threshold:
                continue
            out.append({
                "label": item.get("label", ""),
                "confidence": round(float(conf), 4),
                "bbox": item.get("bbox", [0.0, 0.0, 0.0, 0.0]),
            })
        return {"objects": out}
    except Exception as e:
        logger.warning("object_pipeline 推理失败: %s" % e)
        return {"objects": []}
