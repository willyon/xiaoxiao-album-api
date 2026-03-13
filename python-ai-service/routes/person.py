#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人物分析路由
- 统一 decode_image + normalize_device + ModelManager + pipeline
- 功能：人脸识别（年龄/性别/表情）+ 人体检测（YOLOv11x + RTMW姿态估计）
"""

from fastapi import APIRouter, Request, UploadFile, File, Form, HTTPException

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.person_pipeline import analyze_person as analyze_person_pipeline
from schemas.error_schema import ErrorBody
from services.model_manager import get_model_manager
from utils.device import normalize_device
from utils.errors import AiTimeoutError, AiServiceError
from utils.image_decode import decode_image
from utils.request_log_context import get_image_size, set_request_log_context


router = APIRouter()


@router.post("/analyze_person")
async def analyze_person_route(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """
    分析图片中的人物（包括人脸和人体检测）。
    - 输入：multipart/form-data: image, profile?, device?
    - 输出：与原 person_analysis_service 一致的结果结构
    """
    try:
        resolved, err = normalize_device(device)
        set_request_log_context(request, profile=profile, requested_device=device, resolved_device=resolved)
        if err:
            set_request_log_context(request, error_code=err or AI_DEVICE_NOT_SUPPORTED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(
                    error_code=err or AI_DEVICE_NOT_SUPPORTED,
                    error_message="设备参数无效或不可用",
                ).dict(),
            )

        image_bytes = await image.read()
        if not image_bytes:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(
                    error_code=IMAGE_DECODE_FAILED,
                    error_message="图片数据为空",
                ).dict(),
            )

        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(
                    error_code=IMAGE_DECODE_FAILED,
                    error_message=decode_err or "图片解码失败",
                ).dict(),
            )

        set_request_log_context(request, image_size=get_image_size(img))
        manager = get_model_manager()
        result = analyze_person_pipeline(img, profile, resolved, manager)
        set_request_log_context(request, result_count=1)
        return result

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
    except ValueError as e:
        set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=str(e)).dict(),
        )
    except Exception as e:  # pragma: no cover
        logger.error("人物分析失败", details={"error": str(e)})
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=str(e)).dict(),
        )

