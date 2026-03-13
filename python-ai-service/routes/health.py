#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
健康检查路由
扩展：cuda_available、resolved_device、各能力是否已加载、支持 profile 列表
"""

from fastapi import APIRouter

from config import settings
from loaders.ocr_loader import is_ocr_loaded
from services.model_manager import get_model_manager
from services.model_registry import MODEL_CONFIGS, get_model_version
from utils.device import cuda_available, resolve_device


router = APIRouter()


@router.get('/health')
async def health_check():
    """健康检查：status、cuda_available、resolved_device、各能力加载状态、profile 列表"""
    manager = get_model_manager()
    resolved = resolve_device(settings.DEFAULT_DEVICE)
    capabilities = manager.capabilities_loaded()
    profiles_capabilities = {p: manager.capabilities_loaded_for_profile(p) for p in settings.SUPPORTED_PROFILES}
    response = {
        "status": "healthy",
        "cuda_available": cuda_available(),
        "resolved_device": resolved,
        "profiles": list(settings.SUPPORTED_PROFILES),
        "capabilities": capabilities,
        "profiles_capabilities": profiles_capabilities,
    }

    # 按当前 capabilities 计算 face/ocr 相关聚合字段，便于前端/监控直接使用
    response.update(
        {
            "models_loaded": capabilities.get("face", False) or capabilities.get("ocr", False),
            "face_loaded": capabilities.get("face", False),
            "ocr_loaded": capabilities.get("ocr", False),
            "services": {
                "face_recognition": capabilities.get("face", False),
                "ocr_recognition": capabilities.get("ocr", False),
            },
        }
    )
    return response


@router.get("/capabilities")
async def capabilities_view():
    """
    能力视图：
    - model_versions：各能力使用的模型及版本
    - capabilities：当前是否已加载可用
    - profiles：支持的分析档位
    - taxonomy_version：与 Node 侧约定的分类版本号
    """
    manager = get_model_manager()
    capabilities = manager.capabilities_loaded()
    runtime_models = manager.runtime_model_report(device="cpu")

    def _ver(model_id: str):
        return {"model_id": model_id, "version": get_model_version(model_id)}

    model_versions = {
        "caption_standard": _ver("caption.standard.qwen2_5_vl.3b_lazy"),
        "caption_enhanced": _ver("caption.enhanced.qwen2_5_vl.3b"),
        "object_standard": _ver("object.standard.yolo.11x"),
        "object_enhanced": _ver("object.enhanced.yolo.11x"),
        "embedding_standard": _ver("embedding.standard.siglip2.base"),
        "embedding_enhanced": _ver("embedding.enhanced.siglip2.so400m"),
        "cleanup_head": _ver("cleanup.shared.aesthetic_head.musiq"),
        "ocr": _ver("ocr.shared.paddleocr.ppocrv5"),
        "face_attribute": _ver("face.standard.fairface.age_gender"),
        "expression": _ver("face.shared.emotiefflib.default"),
    }

    # 额外返回部分模型的元信息（source_type / provider / is_optional），方便前端与运维理解特例
    models_meta = {}
    for mid in [
        "face.shared.insightface.buffalo_l",
        "ocr.shared.paddleocr.ppocrv5",
        "face.shared.emotiefflib.default",
        "face.standard.fairface.age_gender",
        "cleanup.shared.aesthetic_head.musiq",
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
        "capabilities": capabilities,
        "runtime_models": runtime_models,
        "model_versions": model_versions,
        "models_meta": models_meta,
        # 与 Node 约定的 taxonomy 版本；首版固定为 v1，后续可以通过环境变量或配置切换
        "taxonomy_version": "v1",
    }
