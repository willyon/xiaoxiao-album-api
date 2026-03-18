#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 流程：拿引擎 → recognize（内部 resize + bbox 回原图）→ 返回 blocks
"""

from __future__ import annotations

from typing import Any

import numpy as np

from config import normalize_ocr_trigger_mode, normalize_provider, settings
from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT, OCR_MODEL_MISSING
from logger import logger
from services.module_result import (
    MODULE_STATUS_DISABLED,
    MODULE_STATUS_EMPTY,
    MODULE_STATUS_FAILED,
    MODULE_STATUS_SKIPPED,
    MODULE_STATUS_SUCCESS,
    build_module_result,
    is_ocr_effective,
)
from utils.timeout import run_with_timeout
from utils.errors import AiTimeoutError


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
        # 成功时打印简单统计日志，便于观察 OCR 运行情况
        logger.info(
            "ocr_pipeline.success",
            details={
                "profile": profile,
                "device": device,
                "block_count": len(blocks) if isinstance(blocks, list) else 0,
            },
        )
        return {"blocks": blocks}
    except AiTimeoutError as e:
        # 超时视为模块失败，由上层 orchestrator 捕获并记录 error_code
        logger.warning("ocr_pipeline 超时: %s" % e)
        raise
    except Exception as e:
        # 其他异常同样视为模块失败，避免误报 success
        logger.warning("ocr_pipeline 推理失败: %s" % e)
        raise


def analyze_ocr_detailed(
    image: np.ndarray,
    profile: str,
    device: str,
    model_manager: Any,
    *,
    resolved_provider: str = "local",
    configured_provider: str = "local",
    trigger_mode: str = "always",
    trigger_signals: dict | None = None,
) -> dict:
    """
    提供给 analyze_full 的详细 OCR 结果。
    返回统一模块结果结构：{status, data, error, reason, meta}。
    """
    provider = normalize_provider(resolved_provider)
    normalized_trigger_mode = normalize_ocr_trigger_mode(trigger_mode)
    safe_trigger_signals = trigger_signals if isinstance(trigger_signals, dict) else {}
    base_data = {"blocks": []}
    meta = {
        "resolved_provider": provider,
        "configured_provider": configured_provider,
        "trigger_mode": normalized_trigger_mode,
        "trigger_signals": safe_trigger_signals,
    }

    if provider == "off":
        return build_module_result(
            status=MODULE_STATUS_DISABLED,
            data=base_data,
            reason="provider_off",
            meta=meta,
        )
    if normalized_trigger_mode == "off":
        return build_module_result(
            status=MODULE_STATUS_SKIPPED,
            data=base_data,
            reason="trigger_off",
            meta=meta,
        )
    if provider != "local":
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": f"ocr provider not implemented: {provider}"},
            reason="provider_not_implemented",
            meta=meta,
        )

    engine = model_manager.get_ocr_engine(profile, device) if model_manager else None
    if engine is None:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": OCR_MODEL_MISSING, "message": "ocr model unavailable"},
            reason="model_unavailable",
            meta=meta,
        )

    meta["model"] = type(engine).__name__
    try:
        timeout = getattr(settings, "OCR_TIMEOUT_SECONDS", 20.0)
        blocks = run_with_timeout(engine.recognize, timeout, image)
        data = {"blocks": blocks if isinstance(blocks, list) else []}
        if is_ocr_effective(data):
            logger.info(
                "ocr_pipeline.success",
                details={"profile": profile, "device": device, "block_count": len(data["blocks"])},
            )
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=data, meta=meta)
        return build_module_result(
            status=MODULE_STATUS_EMPTY,
            data=data,
            reason="no_text_detected",
            meta=meta,
        )
    except AiTimeoutError as e:
        logger.warning("ocr_pipeline 超时: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_TIMEOUT, "message": str(e)},
            reason="provider_timeout",
            meta=meta,
        )
    except Exception as e:
        logger.warning("ocr_pipeline 推理失败: %s" % e)
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data=base_data,
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
            reason="provider_exception",
            meta=meta,
        )
