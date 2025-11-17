#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能清理指标接口
"""

from fastapi import APIRouter, File, HTTPException, UploadFile

from logger import logger
from services.cleanup_analysis_service import analyze_image_from_bytes
import time

router = APIRouter()


@router.post("/analyze_cleanup")
async def analyze_cleanup(image: UploadFile = File(..., max_size=50 * 1024 * 1024)):
    """
    生成智能清理所需的图片指标
    """
    try:
        t0 = time.perf_counter()
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="图片数据为空")

        logger.info(
            "cleanup.request.start",
            details={"filename": image.filename, "size": len(image_bytes)},
        )
        result = analyze_image_from_bytes(image_bytes)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "cleanup.request.done",
            details={
                "filename": image.filename,
                "elapsed_ms": elapsed_ms,
                "has_hashes": bool(result.get("hashes")),
                "has_embed": bool(result.get("embedding")),
                "sharpness_score": result.get("sharpness_score"),
                "aesthetic_score": result.get("aesthetic_score"),
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

