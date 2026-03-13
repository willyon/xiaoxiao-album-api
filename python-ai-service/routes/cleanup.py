#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能清理指标接口
- 统一 decode_image + ModelManager + pipeline
- 保持原有请求参数兼容（skip_embedding / existing_embedding / embedding_model）
"""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
import json
import time
from typing import List, Optional

from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT, IMAGE_DECODE_FAILED
from logger import logger
from pipelines.cleanup_pipeline import analyze_cleanup as analyze_cleanup_pipeline
from schemas.error_schema import ErrorBody
from services.model_manager import get_model_manager
from utils.errors import AiTimeoutError, AiServiceError
from utils.image_decode import decode_image
from utils.request_log_context import get_image_size, set_request_log_context

router = APIRouter()


@router.post("/analyze_cleanup")
async def analyze_cleanup(
    request: Request,
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    skip_embedding: str = Form(None),
    existing_embedding: str = Form(None),
    embedding_model: str = Form(None),
):
    """
    生成智能清理所需的图片指标

    参数:
    - image: 图片文件（必需）
    - skip_embedding: 是否跳过 SigLIP embedding 计算（"true" 表示跳过）
    - existing_embedding: 已有的 embedding 向量（JSON 字符串）
    - embedding_model: embedding 模型 ID（默认 "siglip2"）
    """
    set_request_log_context(request, profile="standard", requested_device="cpu", resolved_device="cpu")
    try:
        t0 = time.perf_counter()
        image_bytes = await image.read()
        if not image_bytes:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="图片数据为空").dict(),
            )

        # 解析已有的 embedding（如果提供）
        existing_embedding_vector: Optional[List[float]] = None
        if skip_embedding == "true" and existing_embedding:
            try:
                existing_embedding_vector = json.loads(existing_embedding)
                if not isinstance(existing_embedding_vector, list):
                    raise ValueError("existing_embedding 必须是数组")
            except (json.JSONDecodeError, ValueError) as e:
                logger.warning(
                    "解析 existing_embedding 失败，将重新计算",
                    details={"error": str(e)},
                )
                existing_embedding_vector = None

        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            set_request_log_context(request, error_code=IMAGE_DECODE_FAILED)
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
            )

        set_request_log_context(request, image_size=get_image_size(img))
        manager = get_model_manager()
        result = analyze_cleanup_pipeline(
            img,
            profile="standard",
            device="cpu",
            manager=manager,
            existing_embedding=existing_embedding_vector,
            embedding_model=embedding_model or "siglip2",
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
            "analyze_cleanup 处理失败",
            details={"error": str(exc), "filename": getattr(image, "filename", None)},
        )
        set_request_log_context(request, error_code=AI_SERVICE_ERROR)
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="图片清理分析失败").dict(),
        ) from exc

