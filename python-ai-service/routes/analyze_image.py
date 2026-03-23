#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全量分析主入口：POST /analyze_image
入参 image、device、image_id；仅支持 image 二进制。
返回统一结构（image_id, duration_ms, data：embedding / person / quality / caption）。
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from typing import Optional

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, IMAGE_DECODE_FAILED
from config import settings
from logger import logger
from schemas.error_schema import ErrorBody
from services.analyze_image_orchestrator import run_analyze_image
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.response_log_redact import redact_embeddings_for_log

router = APIRouter()


@router.post("/analyze_image")
async def analyze_image_route(
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    device: str = Form("auto"),
    image_id: Optional[str] = Form(None),
):
    """
    全量图片分析：串行执行各模块（含 caption/person/quality/embedding 等），
    返回统一结构。Node 写库只读 response.data 下各模块。
    """
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
    result = run_analyze_image(
        image_bgr=img_bgr,
        device=resolved,
        manager=manager,
        image_id=image_id,
    )
    # 开发环境：返回 Node 前打一行与响应同结构的预览（已剔除 embedding/长 vector）
    if getattr(settings, "LOG_ANALYZE_IMAGE_RESULT", False):
        try:
            preview = redact_embeddings_for_log(jsonable_encoder(result))
            logger.info(
                "analyze_image_return_preview",
                details={
                    "image_id": image_id,
                    "note": "与返回 Node 同结构；已剔除 embedding。",
                    "response": preview,
                },
            )
        except Exception:
            pass
    # numpy / 其它非 JSON 原生类型需经 jsonable_encoder，否则 Starlette 序列化会 500
    return JSONResponse(content=jsonable_encoder(result))
