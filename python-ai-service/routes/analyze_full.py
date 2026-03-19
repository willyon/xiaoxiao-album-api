#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全量分析主入口：POST /analyze_full
入参 image/profile/device/image_id/request_id；仅支持 image 二进制。
返回统一结构（task_id, status, modules, errors, timing, created_at）。
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from typing import Optional

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, IMAGE_DECODE_FAILED
from logger import logger
from schemas.error_schema import ErrorBody
from services.analyze_full_orchestrator import run_analyze_full
from services.model_manager import get_model_manager
from config import normalize_profile, settings
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post("/analyze_full")
async def analyze_full_route(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
    image_id: Optional[str] = Form(None),
    request_id: Optional[str] = Form(None),
):
    """
    全量图片分析：按 profile 串行执行 caption/scene/objects/person/ocr/quality/embedding，
    返回统一结构。Node 写库只读 response.modules。
    """
    profile = normalize_profile(profile)
    resolved, err = normalize_device(device)
    set_request_log_context(request, profile=profile, requested_device=device, resolved_device=resolved)
    if err:
        set_request_log_context(request, error_code=err or AI_DEVICE_NOT_SUPPORTED)
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=err or AI_DEVICE_NOT_SUPPORTED, error_message="设备参数无效或不可用").dict(),
        )
    image_bytes = await image.read()
    if not image_bytes:
        set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="图片数据为空").dict(),
        )
    img_bgr, decode_err = decode_image(image_bytes)
    if decode_err or img_bgr is None:
        set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
        )
    set_request_log_context(request, image_size=get_image_size(img_bgr))
    manager = get_model_manager()
    result = run_analyze_full(
        image_bgr=img_bgr,
        profile=profile,
        device=resolved,
        manager=manager,
        image_id=image_id,
        request_id=request_id,
    )
    modules = result.get("modules") or {}
    caption_module = modules.get("caption") or {}
    ocr_module = modules.get("ocr") or {}
    caption_meta = caption_module.get("meta") or {}
    ocr_meta = ocr_module.get("meta") or {}
    trigger_signals = ocr_meta.get("trigger_signals") if isinstance(ocr_meta.get("trigger_signals"), dict) else {}
    ocr_status = str(ocr_module.get("status") or "")
    set_request_log_context(
        request,
        result_count=len(modules),
        error_code=(result.get("errors") or [{}])[0].get("code") if result.get("errors") else None,
        configured_provider=str(ocr_meta.get("configured_provider") or caption_meta.get("configured_provider") or ""),
        resolved_provider=str(ocr_meta.get("resolved_provider") or caption_meta.get("resolved_provider") or ""),
        configured_vendor=str(ocr_meta.get("configured_vendor") or caption_meta.get("configured_vendor") or ""),
        resolved_vendor=str(ocr_meta.get("resolved_vendor") or caption_meta.get("resolved_vendor") or ""),
        ocr_trigger_mode=str(ocr_meta.get("trigger_mode") or ""),
        ocr_triggered=ocr_status in {"success", "empty", "failed"},
        ocr_signal_has_dense_text_like_regions=bool(trigger_signals.get("has_dense_text_like_regions")),
        ocr_signal_caption_hint_text_related=bool(trigger_signals.get("caption_hint_text_related")),
        caption_status=str(caption_module.get("status") or ""),
        ocr_status=ocr_status,
        top_status=str(result.get("status") or ""),
    )
    # 调试用途：仅开发环境打印完整分析结果
    if getattr(settings, "LOG_ANALYZE_FULL_RESULT", False):
        try:
            log_modules = {k: v for k, v in modules.items() if k != "embedding"}
            logger.info(
                "analyze_full_result",
                details={
                    "image_id": image_id,
                    "request_id": request_id,
                    "status": result.get("status"),
                    "modules": log_modules,
                    "ocr_trigger_signals": {
                        "has_dense_text_like_regions": bool(trigger_signals.get("has_dense_text_like_regions")),
                        "caption_hint_text_related": bool(trigger_signals.get("caption_hint_text_related")),
                    },
                    "errors": result.get("errors"),
                    "timing": result.get("timing"),
                },
            )
        except Exception:
            # 日志失败不影响主流程返回
            pass
    return result
