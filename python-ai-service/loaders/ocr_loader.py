#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 模型加载器
负责 PaddleOCR 模型的加载和状态管理
"""

from logger import logger
from config import settings
from services.model_registry import get_model_config, resolve_local_path
import os


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

        from paddleocr import PaddleOCR

        # 允许通过模型注册表指定 PaddleOCR 缓存目录（阶段 4：可选增强）
        cfg = get_model_config("ocr.shared.paddleocr.ppocrv5")
        if cfg and cfg.local_path:
            resolved_home = resolve_local_path(cfg.local_path)
            # PaddleOCR 识别会在 PADDLEOCR_HOME 下缓存下载的模型文件
            os.environ["PADDLEOCR_HOME"] = os.path.expanduser(resolved_home)

        logger.info("正在加载 PaddleOCR 模型...")
        paddle_ocr = PaddleOCR(use_angle_cls=True, lang="ch")
        ocr_loaded = True
        logger.info("✅ PaddleOCR 模型加载完成")

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
