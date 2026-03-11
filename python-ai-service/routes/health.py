#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
健康检查路由
扩展：cuda_available、resolved_device、各能力是否已加载、支持 profile 列表
"""

from fastapi import APIRouter

from config import settings
from loaders.model_loader import all_face_models_loaded
from loaders.ocr_loader import is_ocr_loaded
from services.model_manager import get_model_manager
from utils.device import cuda_available, resolve_device


router = APIRouter()


@router.get('/health')
async def health_check():
    """健康检查：status、cuda_available、resolved_device、各能力加载状态、profile 列表"""
    manager = get_model_manager()
    resolved = resolve_device(settings.DEFAULT_DEVICE)
    capabilities = manager.capabilities_loaded()
    return {
        "status": "healthy",
        "cuda_available": cuda_available(),
        "resolved_device": resolved,
        "profiles": list(settings.SUPPORTED_PROFILES),
        "capabilities": capabilities,
        # 兼容旧字段
        "models_loaded": all_face_models_loaded() or is_ocr_loaded(),
        "face_loaded": capabilities.get("face", all_face_models_loaded()),
        "ocr_loaded": capabilities.get("ocr", is_ocr_loaded()),
        "services": {
            "face_recognition": capabilities.get("face", all_face_models_loaded()),
            "ocr_recognition": capabilities.get("ocr", is_ocr_loaded()),
        },
    }


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

    # 首版直接按文档拍板模型选型；后续如有变更，可改为从 settings 或 metadata 读取
    model_versions = {
        "caption": "Qwen2.5-VL-3B-Instruct",
        "objects": "YOLO11l",
        "scene": "SigLIP2-base-patch16-384",
        "ocr": "PaddleOCR-PP-OCRv5",
        "face": "InsightFace-buffalo_l",
        "cleanup": "SigLIP2 + AestheticHead-MUSIQ",
        "image_embedding": "SigLIP2-base-patch16-384",
        "text_embedding": "SigLIP2-text-encoder",
    }

    return {
        "profiles": list(settings.SUPPORTED_PROFILES),
        "capabilities": capabilities,
        "model_versions": model_versions,
        # 与 Node 约定的 taxonomy 版本；首版固定为 v1，后续可以通过环境变量或配置切换
        "taxonomy_version": "v1",
    }
