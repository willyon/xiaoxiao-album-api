#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能清理指标接口
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
import json

from logger import logger
from services.cleanup_analysis_service import analyze_image_from_bytes
import time

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
        existing_embedding_vector = None
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

        logger.info(
            "cleanup.request.start",
            details={
                "filename": image.filename,
                "size": len(image_bytes),
                "skip_embedding": skip_embedding == "true",
                "has_existing_embedding": existing_embedding_vector is not None,
            },
        )
        result = analyze_image_from_bytes(image_bytes, existing_embedding_vector, embedding_model or "siglip2")
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

