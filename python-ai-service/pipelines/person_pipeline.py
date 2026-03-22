#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人物分析 pipeline
- 输入：统一解码后的 BGR 图像 + device + ModelManager
- 目前复用 person_analysis_service 中的核心逻辑，后续可逐步迁移到 models/person_model.py
"""

from __future__ import annotations

from typing import Any, Dict

import numpy as np

from logger import logger


def analyze_person(image_bgr: np.ndarray, device: str, manager: Any) -> Dict[str, Any]:
    """
    人物分析入口。

    新版：
    - 通过 ModelManager 获取 PersonAnalyzer 实例
    - 由模型类负责具体分析逻辑
    """
    if image_bgr is None:
        logger.warning("analyze_person: 收到空图像，返回空结果")
        return {
            "face_count": 0,
            "person_count": 0,
            "faces": [],
            "summary": {"expressions": [], "ages": [], "genders": []},
        }

    try:
        model = manager.get_face_model(device) if manager else None
        if model is None:
            logger.warning("analyze_person: 未获取到人物分析模型，返回空结果")
            return {
                "face_count": 0,
                "person_count": 0,
                "faces": [],
                "summary": {"expressions": [], "ages": [], "genders": []},
            }
        return model.analyze(image_bgr, device=device)
    except Exception as exc:  # pragma: no cover
        logger.error("analyze_person 处理失败", details={"error": str(exc)})
        raise

