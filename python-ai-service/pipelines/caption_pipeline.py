#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Caption 分析流程：拿模型 → 生成 caption + keywords → 返回统一结构
"""

from __future__ import annotations

from typing import Any, Dict, List

import numpy as np

from config import normalize_provider, settings
from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT, CAPTION_MODEL_MISSING
from logger import logger
from services.module_result import (
    MODULE_STATUS_DISABLED,
    MODULE_STATUS_EMPTY,
    MODULE_STATUS_FAILED,
    MODULE_STATUS_SUCCESS,
    build_module_result,
    is_caption_effective,
)
from utils.timeout import run_with_timeout
from utils.errors import AiTimeoutError


def analyze_caption(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
) -> Dict[str, Any]:
    """
    执行 caption 分析，统一返回 {"caption", "keywords"} 结构。
    - 所有 profile（standard/enhanced）统一使用 VLM（QwenCaptionModel）作为唯一语义源；
    - 若 VLM 返回 dict，则期望包含 {"caption", "keywords"} 字段；
    - 若 VLM 返回字符串，则视为 caption，并通过模型自身的 extract_keywords 生成 keywords。
    无模型或推理异常时返回极简空结果，避免接口整体失败。
    """
    model = model_manager.get_caption_model(profile, device) if model_manager else None
    if model is None:
        return _structured_caption()
    try:
        # 使用统一超时包装，避免单次推理长时间阻塞
        timeout = getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0)
        result = run_with_timeout(model.generate_caption, timeout, image)

        caption: str = ""
        keywords: List[str] = []

        # VLM 直接返回结构化 JSON
        if isinstance(result, dict):
            caption = str(result.get("caption") or "").strip()
            raw = result.get("keywords") or []
            if isinstance(raw, (list, tuple)):
                keywords = [str(x).strip() for x in raw if str(x).strip()]
        # VLM 返回纯文本 caption
        elif isinstance(result, str):
            caption = result.strip()
            if hasattr(model, "extract_keywords"):
                try:
                    kw = model.extract_keywords(caption)
                except Exception as kw_exc:  # pragma: no cover - 关键词提取失败时仅记日志
                    logger.warning("caption_pipeline 提取关键词失败: %s" % kw_exc)
                    kw = []
                if isinstance(kw, (list, tuple)):
                    keywords = [str(x).strip() for x in kw if str(x).strip()]
        else:
            logger.warning("caption_pipeline: generate_caption 返回了非预期类型: %s" % type(result))

        return {
            "caption": caption or "",
            "keywords": keywords,
        }
    except Exception as e:
        logger.warning("caption_pipeline 推理失败: %s" % e)
        return _structured_caption()


def analyze_caption_detailed(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
    *,
    resolved_provider: str = "local",
) -> Dict[str, Any]:
    """
    提供给 analyze_full 的详细 caption 结果。
    返回统一模块结果结构：{status, data, error, reason, meta}。
    """
    provider = normalize_provider(resolved_provider)
    base_data = _structured_caption()
    meta: Dict[str, Any] = {
        "resolved_provider": provider,
        "configured_provider": provider,
    }
    if provider == "off":
        return build_module_result(
            status=MODULE_STATUS_DISABLED,
            data=base_data,
            reason="provider_off",
            meta=meta,
        )
    if provider != "local":
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": f"caption provider not implemented: {provider}"},
            reason="provider_not_implemented",
            meta=meta,
        )

    model = model_manager.get_caption_model(profile, device) if model_manager else None
    if model is None:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": CAPTION_MODEL_MISSING, "message": "caption model unavailable"},
            reason="model_unavailable",
            meta=meta,
        )

    meta["model"] = getattr(model, "model_id", type(model).__name__)
    try:
        timeout = getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0)
        result = run_with_timeout(model.generate_caption, timeout, image)
        data = _coerce_caption_result(result, model)
        if is_caption_effective(data):
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=data, meta=meta)
        return build_module_result(
            status=MODULE_STATUS_EMPTY,
            data=data,
            reason="no_caption_generated",
            meta=meta,
        )
    except AiTimeoutError as e:
        logger.warning("caption_pipeline 超时: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_TIMEOUT, "message": str(e)},
            reason="provider_timeout",
            meta=meta,
        )
    except Exception as e:
        logger.warning("caption_pipeline 推理失败: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
            reason="provider_exception",
            meta=meta,
        )


def _structured_caption(
    caption: str | None = None,
    keywords: List[str] | None = None,
) -> Dict[str, Any]:
    """
    在 VLM 不可用或抛错时的极简 fallback，保证接口不会挂掉。
    当前阶段策略：
    - 不再依赖 scene/object 模块；
    - 直接返回空或调用方传入的极简结果；
    - keywords 直接作为对外唯一关键词字段。
    """
    safe_caption = (caption or "").strip()
    kw_list: List[str] = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    return {
        "caption": safe_caption,
        "keywords": kw_list,
    }


def _coerce_caption_result(result: Any, model: Any) -> Dict[str, Any]:
    """将 caption 模型输出转为统一 data 结构。"""
    caption: str = ""
    keywords: List[str] = []

    if isinstance(result, dict):
        caption = str(result.get("caption") or "").strip()
        raw = result.get("keywords") or []
        if isinstance(raw, (list, tuple)):
            keywords = [str(x).strip() for x in raw if str(x).strip()]
    elif isinstance(result, str):
        caption = result.strip()
        if hasattr(model, "extract_keywords"):
            try:
                kw = model.extract_keywords(caption)
            except Exception as kw_exc:  # pragma: no cover
                logger.warning("caption_pipeline 提取关键词失败: %s" % kw_exc)
                kw = []
            if isinstance(kw, (list, tuple)):
                keywords = [str(x).strip() for x in kw if str(x).strip()]
    else:
        logger.warning("caption_pipeline: generate_caption 返回了非预期类型: %s" % type(result))

    return {
        "caption": caption or "",
        "keywords": keywords,
    }
