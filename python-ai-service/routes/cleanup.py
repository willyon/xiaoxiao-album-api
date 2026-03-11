#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能清理指标接口
- 统一 decode_image + ModelManager + pipeline
- 保持原有请求参数兼容（skip_embedding / existing_embedding / embedding_model）
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
import json
import time
from typing import List, Optional

from logger import logger
from pipelines.cleanup_pipeline import analyze_cleanup as analyze_cleanup_pipeline
from services.model_manager import get_model_manager
from utils.image_decode import decode_image

router = APIRouter()


@router.post("/analyze_cleanup")
async def analyze_cleanup(
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
    try:
        t0 = time.perf_counter()
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="图片数据为空")

        # 解析已有的 embedding（如果提供）
        existing_embedding_vector: Optional[List[float]] = None
        if skip_embedding == "true" and existing_embedding:
            try:
                existing_embedding_vector = json.loads(existing_embedding)
                if not isinstance(existing_embedding_vector, list):
                    raise ValueError("existing_embedding 必须是数组")
            except (json.JSONDecodeError, ValueError) as e:
                logger.warn(
                    "解析 existing_embedding 失败，将重新计算",
                    details={"error": str(e)},
                )
                existing_embedding_vector = None

        img, decode_err = decode_image(image_bytes)
        if decode_err or img is None:
            raise HTTPException(status_code=400, detail=decode_err or "图片解码失败")

        logger.info(
            "cleanup.request.start",
            details={
                "filename": image.filename,
                "size": len(image_bytes),
                "skip_embedding": skip_embedding == "true",
                "has_existing_embedding": existing_embedding_vector is not None,
            },
        )

        manager = get_model_manager()
        result = analyze_cleanup_pipeline(
            img,
            profile="standard",
            device="cpu",
            manager=manager,
            existing_embedding=existing_embedding_vector,
            embedding_model=embedding_model or "siglip2",
        )

        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "cleanup.request.done",
            details={
                "filename": image.filename,
                "elapsed_ms": elapsed_ms,
                "has_hashes": bool(result.get("hashes")),
                "has_embed": bool(result.get("embedding")),
                "aesthetic_score": result.get("aesthetic_score"),
                "sharpness_score": result.get("sharpness_score"),
                "skipped_embedding": skip_embedding == "true",
            },
        )
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # pragma: no cover
        logger.error(
            "analyze_cleanup 处理失败",
            details={"error": str(exc), "filename": image.filename},
        )
        raise HTTPException(status_code=500, detail="图片清理分析失败") from exc

