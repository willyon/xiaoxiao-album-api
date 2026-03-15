#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
物体检测路由：POST /analyze_objects
Form: image, profile, device；统一 decode_image + normalize_device + pipeline
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.object_pipeline import analyze_objects
from schemas.error_schema import ErrorBody
from schemas.object_schema import ObjectItem, ObjectResponse
from config import normalize_profile
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.errors import AiTimeoutError, AiServiceError
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post(
    "/analyze_objects",
    response_model=ObjectResponse,
    responses={
        400: {"description": "Bad request", "model": ErrorBody},
        500: {"description": "Internal error", "model": ErrorBody},
    },
)
async def analyze_objects_route(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """检测图片中的物体，返回 Raw Label。无模型时返回空列表。"""
    try:
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
        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
            )
        set_request_log_context(request, image_size=get_image_size(img))
        manager = get_model_manager()
        result = analyze_objects(img, profile, resolved, manager)
        items = [ObjectItem(label=o["label"], confidence=o["confidence"], bbox=o["bbox"]) for o in result.get("objects", [])]
        set_request_log_context(request, result_count=len(items))
        return ObjectResponse(objects=items)
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
        logger.error("analyze_objects 异常", details={"error": str(e)})
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=str(e)).dict(),
        )
