#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 模型加载器
负责 PaddleOCR 模型的加载和状态管理
"""

from logger import logger
from config import settings


# 全局变量存储模型
paddle_ocr = None
ocr_loaded = False


def load_ocr_model():
    """加载 OCR 模型"""
    global paddle_ocr, ocr_loaded
    
    try:
        if not settings.OCR_ENABLED:
            logger.info("OCR 功能已禁用")
            ocr_loaded = False
            return
            
        # 暂时禁用 PaddleOCR，避免 macOS 兼容性问题
        logger.warning("⚠️ PaddleOCR 暂时禁用，仅支持人脸识别功能")
        paddle_ocr = None
        ocr_loaded = False
        
        # 以下是启用时的代码
        # from paddleocr import PaddleOCR
        # logger.info("正在加载 PaddleOCR 模型...")
        # paddle_ocr = PaddleOCR(use_angle_cls=True, lang='ch')
        # ocr_loaded = True
        # logger.info("✅ PaddleOCR 模型加载完成")
        
    except Exception as e:
        logger.error("❌ PaddleOCR 模型加载失败: %s", str(e))
        paddle_ocr = None
        ocr_loaded = False


def get_ocr_model():
    """获取 OCR 模型"""
    if not ocr_loaded and settings.OCR_ENABLED:
        load_ocr_model()
    return paddle_ocr if ocr_loaded else None


def is_ocr_loaded():
    """检查 OCR 模型是否已加载"""
    return ocr_loaded
