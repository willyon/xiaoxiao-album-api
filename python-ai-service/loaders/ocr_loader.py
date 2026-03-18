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
        # 在 import 前强制指定缓存目录。PaddleX 在 import 时从 paddlex.utils.cache 读 PADDLE_PDX_CACHE_HOME
        cfg = get_model_config("ocr.shared.paddleocr.ppocrv5")
        if cfg and cfg.local_path:
            resolved_home = os.path.abspath(os.path.expanduser(resolve_local_path(cfg.local_path)))
            os.environ["PADDLE_PDX_CACHE_HOME"] = resolved_home
            os.environ["PADDLEOCR_HOME"] = resolved_home
            os.environ["PADDLEX"] = resolved_home
            try:
                import paddlex as pdx
                pdx.pretrain_dir = resolved_home
            except Exception:
                pass

        from paddleocr import PaddleOCR

        logger.info("正在加载 PaddleOCR 模型...")
        paddle_ocr = PaddleOCR(use_angle_cls=True, lang="ch")
        ocr_loaded = True
        logger.info("✅ PaddleOCR 模型加载完成")

    except Exception as e:
        logger.error("PaddleOCR 模型加载失败", details={"error": str(e)})
        paddle_ocr = None
        ocr_loaded = False


def get_ocr_model():
    """获取 OCR 模型"""
    if not ocr_loaded:
        load_ocr_model()
    return paddle_ocr if ocr_loaded else None


def is_ocr_loaded():
    """检查 OCR 模型是否已加载"""
    return ocr_loaded
