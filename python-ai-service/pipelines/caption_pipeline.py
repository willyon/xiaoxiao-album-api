#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Caption 分析流程：统一走云 VLM（千问 / OpenAI 兼容），
生成 description、keywords、subject/action/scene 标签与 ocr 等字段。
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from config import normalize_provider, settings
from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT
from logger import logger
from providers import get_caption_provider
from services.module_result import MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result
from utils.errors import AiTimeoutError
from providers.qwen_common import normalize_keywords


def analyze_caption(
    image: np.ndarray,
    device: str,
    model_manager: Any,
) -> Dict[str, Any]:
    """
    执行 caption 分析，统一返回 description / keywords / subject_tags / action_tags / scene_tags / ocr。
    与 analyze_full 一致：仅云 provider。
    """
    detailed = analyze_caption_detailed(
        image,
        device,
        model_manager,
    )
    status = detailed.get("status")
    data = detailed.get("data") or {}
    if status == MODULE_STATUS_SUCCESS:
        return {
            "description": str(data.get("description") or "").strip(),
            "keywords": list(data.get("keywords") or []),
            "subject_tags": normalize_keywords(data.get("subject_tags") or []),
            "action_tags": normalize_keywords(data.get("action_tags") or []),
            "scene_tags": normalize_keywords(data.get("scene_tags") or []),
            "ocr": str(data.get("ocr") or "").strip(),
        }
    return _structured_caption_payload()


def analyze_caption_detailed(
    image: np.ndarray,
    device: str,
    model_manager: Any,
    *,
    resolved_provider: str | None = None,
) -> Dict[str, Any]:
    """
    提供给 analyze_full 的详细 caption 模块结果。
    返回统一模块结果结构：{status, data, error}。
    """
    configured_provider = getattr(settings, "CAPTION_PROVIDER", "cloud")
    resolved = normalize_provider(resolved_provider if resolved_provider is not None else configured_provider)
    base_data = _structured_caption_payload()
    if resolved == "off":
        return build_module_result(
            status=MODULE_STATUS_SUCCESS,
            data=base_data,
        )

    provider = get_caption_provider(resolved)
    if provider is None:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": f"caption provider unavailable: {resolved}"},
        )

    try:
        out = provider.analyze(
            image,
            device=device,
            model_manager=model_manager,
            configured_provider=configured_provider,
            resolved_provider=resolved,
        )
        return out
    except AiTimeoutError as e:
        logger.warning("caption_pipeline 超时: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_TIMEOUT, "message": str(e)},
        )
    except Exception as e:
        logger.warning("caption_pipeline 推理失败: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
        )


def _structured_caption_payload(
    text: str | None = None,
    keywords: List[str] | None = None,
    subject_tags: List[str] | None = None,
    action_tags: List[str] | None = None,
    scene_tags: List[str] | None = None,
) -> Dict[str, Any]:
    safe_text = (text or "").strip()
    kw_list: List[str] = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    return {
        "description": safe_text,
        "keywords": kw_list,
        "subject_tags": normalize_keywords(subject_tags or []),
        "action_tags": normalize_keywords(action_tags or []),
        "scene_tags": normalize_keywords(scene_tags or []),
        "ocr": "",
    }
