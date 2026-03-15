#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
场景分类路由：POST /analyze_scene
Form: image, profile, device；统一 decode_image + normalize_device + pipeline
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.scene_pipeline import analyze_scene
from schemas.error_schema import ErrorBody
from schemas.scene_schema import SceneResponse
from config import normalize_profile
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.image_decode import decode_image
from utils.errors import AiTimeoutError, AiServiceError
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post(
    "/analyze_scene",
    response_model=SceneResponse,
    responses={
        400: {"description": "Bad request", "model": ErrorBody},
        500: {"description": "Internal error", "model": ErrorBody},
    },
)
async def analyze_scene_route(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """场景分类，返回 primary_scene + scene_tags。无模型时返回空结构。"""
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
        result = analyze_scene(img, profile, resolved, manager)
        set_request_log_context(request, result_count=1)
        return SceneResponse(
            primary_scene=result.get("primary_scene"),
            scene_tags=result.get("scene_tags", []),
            confidence=result.get("confidence", 0.0),
        )
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
        logger.error("analyze_scene 异常", details={"error": str(e)})
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=str(e)).dict(),
        )
