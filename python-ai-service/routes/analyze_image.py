#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全量分析主入口：POST /analyze_image
入参二选一：image（二进制）或 image_path（本地可读路径）；以及 device、image_id。
返回统一结构（image_id, duration_ms, data：embedding / person / quality / caption）。
"""

from typing import Optional

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
from utils.analyze_image_path import read_image_bytes_from_path
from utils.image_decode import decode_image
from utils.response_log_redact import redact_embeddings_for_log

router = APIRouter()


@router.post("/analyze_image")
async def analyze_image_route(
    image: Optional[UploadFile] = File(None),
    image_path: Optional[str] = Form(None),
    device: str = Form("auto"),
    image_id: Optional[str] = Form(None),
):
    """
    全量图片分析：串行执行各模块（含 caption/person/quality/embedding 等），
    返回统一结构。Node 写库只读 response.data 下各模块。
    与 image 二选一传入 image_path（本地路径，由 Node 在本地存储时传递）。
    """
    resolved, err = normalize_device(device)
    if err:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=err or AI_DEVICE_NOT_SUPPORTED, error_message="设备参数无效或不可用").dict(),
        )

    has_file = image is not None
    has_path = image_path is not None and str(image_path).strip() != ""

    if has_file and has_path:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="请勿同时上传 image 与 image_path").dict(),
        )
    if not has_file and not has_path:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="请提供 image 或 image_path 之一").dict(),
        )

    if has_path:
        image_bytes, path_err = read_image_bytes_from_path(image_path)
        if path_err or not image_bytes:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=path_err or "无法读取图片路径").dict(),
            )
    else:
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
    if settings.NODE_ENV == "development":
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
