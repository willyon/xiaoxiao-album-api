#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Caption 分析路由：POST /analyze_caption
Form: image, profile, device；统一 decode_image + normalize_device + pipeline
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.caption_pipeline import analyze_caption
from schemas.caption_schema import CaptionResponse
from schemas.error_schema import ErrorBody
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.errors import AiTimeoutError, AiServiceError

router = APIRouter()


@router.post(
    "/analyze_caption",
    response_model=CaptionResponse,
    responses={
        400: {"description": "Bad request", "model": ErrorBody},
        500: {"description": "Internal error", "model": ErrorBody},
    },
)
async def analyze_caption_route(
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """分析图片生成 caption 与 keywords。无模型时返回空 caption/keywords。"""
    try:
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
        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
            )
        manager = get_model_manager()
        result = analyze_caption(img, profile, resolved, manager)
        return CaptionResponse(caption=result["caption"], keywords=result.get("keywords", []))
    except HTTPException:
        raise
    except AiTimeoutError as e:
        raise HTTPException(
            status_code=504,
            detail=ErrorBody(error_code=AI_TIMEOUT, error_message=str(e)).dict(),
        )
    except AiServiceError as e:
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=e.error_code, error_message=e.message).dict(),
        )
    except Exception as e:
        logger.exception("analyze_caption 异常: %s", e)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code="AI_SERVICE_ERROR", error_message=str(e)).dict(),
        )
