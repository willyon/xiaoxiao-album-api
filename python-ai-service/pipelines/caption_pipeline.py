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
    # standard：结构化优先；必要时（配置开启或结构化为空）再按需使用 VLM
    if (profile or "standard").lower() == "standard":
        structured = _structured_caption(image, profile, device, model_manager)
        if structured.get("caption") and not getattr(settings, "CAPTION_STANDARD_USE_VLM", False):
            return structured
    model = model_manager.get_caption_model(profile, device) if model_manager else None
    if model is None:
        # standard：结构化为空且未启用/无法加载 VLM 时，返回结构化结果（可能为空）
        if (profile or "standard").lower() == "standard":
            return _structured_caption(image, profile, device, model_manager)
        return {"caption": "", "keywords": []}
    try:
        # 使用统一超时包装，避免单次推理长时间阻塞
        timeout = getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0)
        caption = run_with_timeout(model.generate_caption, timeout, image)
        keywords = model.extract_keywords(caption) if hasattr(model, "extract_keywords") else []
        return {"caption": caption or "", "keywords": keywords or []}
    except Exception as e:
        logger.warning("caption_pipeline 推理失败: %s" % e)
        if (profile or "standard").lower() == "standard":
            return _structured_caption(image, profile, device, model_manager)
        return {"caption": "", "keywords": []}


def _structured_caption(image: np.ndarray, profile: str, device: str, model_manager: Any) -> dict:
    """
    结构化 caption（standard 档默认策略）：
    - 尽量复用已存在能力：scene + object
    - 失败时返回空 caption/keywords
    """
    out = {"caption": "", "keywords": []}
    if model_manager is None or image is None:
        return out
    try:
        keywords = []
        parts = []

        # scene
        try:
            scene_model = model_manager.get_scene_model(profile, device)
            if scene_model is not None:
                scene = scene_model.classify(image)
                primary = scene.get("primary_scene")
                if primary:
                    parts.append(f"场景：{primary}")
                    keywords.append(str(primary))
        except Exception:
            pass

        # objects
        try:
            obj_model = model_manager.get_object_model(profile, device)
            if obj_model is not None:
                dets = obj_model.detect(image)
                labels = [d.get("label") for d in dets if d.get("label")]
                # 去重并截断
                uniq = []
                seen = set()
                for lb in labels:
                    if lb in seen:
                        continue
                    seen.add(lb)
                    uniq.append(lb)
                    if len(uniq) >= int(getattr(settings, "CAPTION_STRUCTURED_MAX_OBJECTS", 5)):
                        break
                if uniq:
                    parts.append("物体：" + "、".join(uniq))
                    keywords.extend(uniq)
        except Exception:
            pass

        caption = "；".join(parts)
        if caption:
            out["caption"] = caption
            # keywords 去重
            dedup = []
            s2 = set()
            for k in keywords:
                if k not in s2:
                    s2.add(k)
                    dedup.append(k)
            out["keywords"] = dedup
        return out
    except Exception:
        return out
