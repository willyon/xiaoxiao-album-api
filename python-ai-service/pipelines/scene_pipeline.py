#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
场景分类流程：拿模型 → classify → 返回 primary_scene + scene_tags + confidence
"""

from __future__ import annotations

from typing import Any

import numpy as np

from config import settings
from logger import logger
from utils.timeout import run_with_timeout


def analyze_scene(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
) -> dict:
    """
    执行场景分类。无模型时返回 { "primary_scene": null, "scene_tags": [], "confidence": 0.0 }。
    """
    model = model_manager.get_scene_model(profile, device) if model_manager else None
    if model is None:
        return {"primary_scene": None, "scene_tags": [], "confidence": 0.0}
    try:
        timeout = getattr(settings, "SCENE_TIMEOUT_SECONDS", 20.0)
        result = run_with_timeout(model.classify, timeout, image)
        return {
            "primary_scene": result.get("primary_scene"),
            "scene_tags": result.get("scene_tags", []),
            "confidence": float(result.get("confidence", 0.0)),
        }
    except Exception as e:
        logger.warning("scene_pipeline 推理失败: %s" % e)
        return {"primary_scene": None, "scene_tags": [], "confidence": 0.0}
