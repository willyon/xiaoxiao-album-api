#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
健康检查路由
"""

from fastapi import APIRouter

from config import settings
from services.model_manager import get_model_manager
from utils.device import cuda_available, resolve_device


router = APIRouter()


@router.get('/health')
async def health_check():
    """轻量健康检查：不触发模型加载，仅返回服务状态与能力配置摘要。"""
    manager = get_model_manager()
    resolved = resolve_device(settings.DEFAULT_DEVICE)
    configured = manager.capabilities_configured()
    runtime = manager.capabilities_runtime_status(device=resolved)
    response = {
        "status": "healthy",
        "cuda_available": cuda_available(),
        "resolved_device": resolved,
        "capabilities": configured,
    }

    # 聚合字段：只反映配置态，不触发真实加载
    response.update(
        {
            "models_loaded": bool((runtime.get("caption") or {}).get("loaded", False)),
            "face_loaded": False,
            "services": {
                "face_recognition": False,
            },
        }
    )
    return response
