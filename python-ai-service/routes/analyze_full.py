#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全量分析主入口：POST /analyze_full
入参 image/profile/device/image_id/request_id；仅支持 image 二进制。
返回统一结构（task_id, status, modules, errors, timing, created_at）。
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from typing import Optional

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, IMAGE_DECODE_FAILED
from config import normalize_profile, settings
from logger import logger
from schemas.error_schema import ErrorBody
from services.analyze_full_orchestrator import run_analyze_full
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.request_log_context import get_image_size, set_request_log_context
from utils.response_log_redact import redact_embeddings_for_log

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
    全量图片分析：按 profile 串行执行各模块（含 caption/person/quality/embedding 等），
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
    caption_meta = caption_module.get("meta") or {}
    errs = result.get("errors") or []
    first_err = errs[0] if errs and isinstance(errs[0], dict) else None
    set_request_log_context(
        request,
        result_count=len(modules),
        error_code=first_err.get("code") if first_err else None,
        configured_provider=str(caption_meta.get("configured_provider") or ""),
        resolved_provider=str(caption_meta.get("resolved_provider") or ""),
        configured_vendor=str(caption_meta.get("configured_vendor") or ""),
        resolved_vendor=str(caption_meta.get("resolved_vendor") or ""),
        caption_status=str(caption_module.get("status") or ""),
        top_status=str(result.get("status") or ""),
    )
    # 开发环境：返回 Node 前打一行与响应同结构的预览（已剔除 embedding/长 vector）
    if getattr(settings, "LOG_ANALYZE_FULL_RESULT", False):
        try:
            preview = redact_embeddings_for_log(jsonable_encoder(result))
            logger.info(
                "analyze_full_return_preview",
                details={
                    "image_id": image_id,
                    "request_id": request_id,
                    "note": "与返回 Node 同结构；已剔除 embedding；VLM 人脸/人物数见 response.modules.caption.data.face_count / person_count；图中文字见 data.ocr",
                    "response": preview,
                },
            )
        except Exception:
            pass
    # numpy / 其它非 JSON 原生类型需经 jsonable_encoder，否则 Starlette 序列化会 500
    return JSONResponse(content=jsonable_encoder(result))
