#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
健康检查路由
扩展：轻量健康检查 + 配置态/运行态能力视图
"""

from fastapi import APIRouter

from config import settings
from services.model_manager import get_model_manager
from services.model_registry import MODEL_CONFIGS, get_model_version
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


@router.get("/capabilities")
async def capabilities_view():
    """
    能力视图：
    - model_versions：各能力使用的模型及版本
    - configured：配置态 provider / vendor / enabled / available
    - runtime：运行态 loaded / resolved provider / resolved vendor
    - taxonomy_version：与 Node 侧约定的分类版本号
    """
    manager = get_model_manager()
    configured = manager.capabilities_configured()
    runtime = manager.capabilities_runtime_status(device="cpu")
    runtime_models = manager.runtime_model_report(device="cpu")

    def _ver(model_id: str):
        return {"model_id": model_id, "version": get_model_version(model_id)}

    model_versions = {
        "caption_cloud": {
            "model_id": "cloud",
            "version": (getattr(settings, "CAPTION_CLOUD_MODEL", "") or "").strip() or None,
        },
        "object": _ver("object.standard.yolo.11x"),
        "embedding": _ver("embedding.standard.siglip2.base"),
        "quality_head": _ver("quality.shared.aesthetic_head.musiq"),
        "face_attribute": _ver("face.shared.fairface.age_gender"),
        "expression": _ver("face.shared.emotiefflib.default"),
    }

    # 额外返回部分模型的元信息（source_type / provider / is_optional），方便前端与运维理解特例
    models_meta = {}
    for mid in [
        "face.shared.insightface.buffalo_l",
        "face.shared.emotiefflib.default",
        "face.shared.fairface.age_gender",
        "quality.shared.aesthetic_head.musiq",
    ]:
        cfg = MODEL_CONFIGS.get(mid)
        if not cfg:
            continue
        models_meta[mid] = {
            "task_type": cfg.task_type,
            "registry_scope": cfg.registry_scope,
            "source_type": getattr(cfg, "source_type", "local_managed"),
            "provider": getattr(cfg, "provider", None),
            "is_optional": getattr(cfg, "is_optional", False),
        }

    return {
        "configured": configured,
        "runtime": runtime,
        "runtime_models": runtime_models,
        "model_versions": model_versions,
        "models_meta": models_meta,
        "taxonomy_version": "v1",
    }
