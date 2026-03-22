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
    profiles_capabilities = {
        p: manager.capabilities_configured_for_profile(p) for p in settings.SUPPORTED_PROFILES
    }
    response = {
        "status": "healthy",
        "cuda_available": cuda_available(),
        "resolved_device": resolved,
        "profiles": list(settings.SUPPORTED_PROFILES),
        "capabilities": configured,
        "profiles_capabilities": profiles_capabilities,
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
    - profiles：支持的分析档位
    - taxonomy_version：与 Node 侧约定的分类版本号
    """
    manager = get_model_manager()
    configured = manager.capabilities_configured()
    runtime = manager.capabilities_runtime_status(device="cpu")
    profiles_runtime = {p: manager.capabilities_runtime_status_for_profile(p, device="cpu") for p in settings.SUPPORTED_PROFILES}
    runtime_models = manager.runtime_model_report(device="cpu")

    def _ver(model_id: str):
        return {"model_id": model_id, "version": get_model_version(model_id)}

    model_versions = {
        "caption_standard": _ver("caption.standard.qwen2_5_vl.3b_lazy"),
        "caption_enhanced": _ver("caption.enhanced.qwen2_5_vl.7b"),
        "object_standard": _ver("object.standard.yolo.11x"),
        "object_enhanced": _ver("object.enhanced.yolo.26l"),
        "embedding_standard": _ver("embedding.standard.siglip2.base"),
        "embedding_enhanced": _ver("embedding.enhanced.siglip2.so400m"),
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
            "profile_scope": cfg.profile_scope,
            "source_type": getattr(cfg, "source_type", "local_managed"),
            "provider": getattr(cfg, "provider", None),
            "is_optional": getattr(cfg, "is_optional", False),
        }

    return {
        "profiles": list(settings.SUPPORTED_PROFILES),
        "configured": configured,
        "runtime": runtime,
        "profiles_runtime": profiles_runtime,
        "runtime_models": runtime_models,
        "model_versions": model_versions,
        "models_meta": models_meta,
        # 与 Node 约定的 taxonomy 版本；首版固定为 v1，后续可以通过环境变量或配置切换
        "taxonomy_version": "v1",
    }
