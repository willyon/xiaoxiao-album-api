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
from config import normalize_profile
from utils.device import normalize_device
from utils.image_decode import decode_image

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
    if err:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=err or AI_DEVICE_NOT_SUPPORTED, error_message="设备参数无效或不可用").dict(),
        )
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="图片数据为空").dict(),
        )
    img_bgr, decode_err = decode_image(image_bytes)
    if decode_err or img_bgr is None:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
        )
    manager = get_model_manager()
    result = run_analyze_full(
        image_bgr=img_bgr,
        profile=profile,
        device=resolved,
        manager=manager,
        image_id=image_id,
        request_id=request_id,
    )
    return result
