#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POST /analyze_video — 视频智能分析（抽帧 + 复用单图四模块 + 聚合）。
请求体 JSON：video_path（本地可读路径）、device、image_id（媒体 id，透传）。
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, IMAGE_DECODE_FAILED
from config import settings
from logger import logger
from schemas.error_schema import ErrorBody
from services.analyze_video_orchestrator import run_analyze_video
from utils.device import normalize_device
from utils.response_log_redact import redact_embeddings_for_log

router = APIRouter()


class AnalyzeVideoBody(BaseModel):
    video_path: str = Field(..., description="服务端可读的视频文件绝对路径（与 Node 本地存储一致）")
    device: str = Field("auto", description="cpu | cuda | auto")
    image_id: Optional[str] = Field(None, description="媒体 id，回显于响应")
    cloud_config: Optional[dict] = Field(None, description="Node 侧透传的云模型配置（含 api_key 等）")
    modules: Optional[str] = Field(
        None,
        description="可选：逗号分隔的模块名列表，如 'caption' 或 'person,caption'；为空时默认跑 person+caption",
    )


@router.post("/analyze_video")
async def analyze_video_route(body: AnalyzeVideoBody):
    resolved, err = normalize_device(body.device)
    if err:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=err or AI_DEVICE_NOT_SUPPORTED, error_message="设备参数无效或不可用").dict(),
        )

    if not body.video_path or not str(body.video_path).strip():
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="video_path 不能为空").dict(),
        )

    cloud_api_key: Optional[str] = None
    cfg = body.cloud_config
    if isinstance(cfg, dict):
        raw_key = cfg.get("api_key")
        if isinstance(raw_key, str):
            k = raw_key.strip()
            if k:
                cloud_api_key = k

    module_names: Optional[List[str]] = None
    if body.modules:
        raw_list = [m.strip() for m in str(body.modules).split(",") if m and str(m).strip()]
        allowed = {"person", "caption"}
        filtered = [m for m in raw_list if m in allowed]
        if filtered:
            module_names = filtered

    result = run_analyze_video(
        video_path=str(body.video_path).strip(),
        device=resolved,
        image_id=body.image_id,
        cloud_api_key=cloud_api_key,
        module_names=module_names,
    )
    # 开发环境：返回 Node 前打一行与响应同结构的预览（已剔除 embedding / 长向量）
    if settings.NODE_ENV == "development":
        try:
            preview = redact_embeddings_for_log(jsonable_encoder(result))
            logger.info(
                "analyze_video_return_preview",
                details={
                    "image_id": body.image_id,
                    "note": "与返回 Node 同结构；已剔除 embedding。",
                    "response": preview,
                },
            )
        except Exception:
            pass
    return JSONResponse(content=jsonable_encoder(result))
