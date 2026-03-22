#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片质量指标接口（原智能清理）
- 统一 decode_image + ModelManager + pipeline
- 仅返回质量相关：hashes、aesthetic_score、sharpness_score
"""

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
import time

from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.quality_pipeline import analyze_cleanup as analyze_quality_pipeline
from schemas.error_schema import ErrorBody
from services.model_manager import get_model_manager
from utils.errors import AiTimeoutError, AiServiceError
from utils.image_decode import decode_image
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post("/analyze_quality")
async def analyze_quality(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
):
    """
    生成图片质量指标（哈希、清晰度、美学分），供智能清理/筛选使用。
    """
    set_request_log_context(request, requested_device="cpu", resolved_device="cpu")
    try:
        t0 = time.perf_counter()
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
        result = analyze_quality_pipeline(
            img,
            device="cpu",
            manager=manager,
        )

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
    except ValueError as exc:
        set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=str(exc)).dict(),
        )
    except Exception as exc:  # pragma: no cover
        logger.error(
            "analyze_quality 处理失败",
            details={"error": str(exc), "filename": getattr(image, "filename", None)},
        )
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="图片质量分析失败").dict(),
        ) from exc

