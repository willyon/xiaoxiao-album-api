#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Caption 分析流程：拿模型 → 生成 caption + keywords → 返回统一结构
"""

from __future__ import annotations

from typing import Any, Optional

import numpy as np

from config import settings
from logger import logger
from utils.timeout import run_with_timeout


def analyze_caption(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
) -> dict:
    """
    执行 caption 分析。无模型时返回 { "caption": "", "keywords": [] }。
    若需明确区分「能力关闭」与「推理失败」，可由调用方根据 model_manager 判断。
    """
    model = model_manager.get_caption_model(profile, device) if model_manager else None
    if model is None:
        return {"caption": "", "keywords": []}
    try:
        # 使用统一超时包装，避免单次推理长时间阻塞
        timeout = getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0)
        caption = run_with_timeout(model.generate_caption, timeout, image)
        keywords = model.extract_keywords(caption) if hasattr(model, "extract_keywords") else []
        return {"caption": caption or "", "keywords": keywords or []}
    except Exception as e:
        logger.warning("caption_pipeline 推理失败: %s", e)
        return {"caption": "", "keywords": []}
