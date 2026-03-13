#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 文字识别路由：POST /ocr
Form: image, profile?, device?；统一 decode_image + normalize_device + ocr_pipeline
basic 且 OCR 关闭时返回 { "blocks": [] }
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.ocr_pipeline import analyze_ocr
from schemas.error_schema import ErrorBody
from schemas.ocr_schema import OcrBlock, OcrResponse
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.errors import AiTimeoutError, AiServiceError
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post(
    "/ocr",
    response_model=OcrResponse,
    responses={
        400: {"description": "Bad request", "model": ErrorBody},
        500: {"description": "Internal error", "model": ErrorBody},
    },
)
async def ocr_recognize(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """OCR 文字识别，返回 blocks（text, bbox 原图坐标, confidence）。无引擎时返回空 blocks。"""
    try:
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
        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
            )
        set_request_log_context(request, image_size=get_image_size(img))
        manager = get_model_manager()
        result = analyze_ocr(img, profile, resolved, manager)
        blocks = [OcrBlock(text=b["text"], bbox=b["bbox"], confidence=b["confidence"]) for b in result.get("blocks", [])]
        set_request_log_context(request, result_count=len(blocks))
        return OcrResponse(blocks=blocks)
    except HTTPException:
        raise
    except AiTimeoutError as e:
        set_request_log_context(request, error_code=AI_TIMEOUT)
        raise HTTPException(
            status_code=504,
            detail=ErrorBody(error_code=AI_TIMEOUT, error_message=str(e)).dict(),
        )
    except AiServiceError as e:
        set_request_log_context(request, error_code=e.error_code)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=e.error_code, error_message=e.message).dict(),
        )
    except Exception as e:
        logger.error("OCR 异常", details={"error": str(e)})
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=str(e)).dict(),
        )
