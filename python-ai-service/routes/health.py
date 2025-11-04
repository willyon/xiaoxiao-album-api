#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
健康检查路由
"""

from fastapi import APIRouter
from loaders.model_loader import all_face_models_loaded
from loaders.ocr_loader import is_ocr_loaded


# 创建路由器
router = APIRouter()


@router.get('/health')
async def health_check():
    """健康检查"""
    return {
        'status': 'healthy',
        'models_loaded': all_face_models_loaded() or is_ocr_loaded(),
        'face_loaded': all_face_models_loaded(),
        'ocr_loaded': is_ocr_loaded(),
        'services': {
            'face_recognition': all_face_models_loaded(),
            'ocr_recognition': is_ocr_loaded()
        }
    }
