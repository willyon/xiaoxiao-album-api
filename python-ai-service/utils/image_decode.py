#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一图片解码
- 一次 decode，输出方向已校正的 BGR 图（EXIF orientation 已应用）
- 供路由层统一调用，各模型内部只做按需 resize
"""

from __future__ import annotations

import io
from typing import Optional, Tuple

import cv2
import numpy as np

from logger import logger

# Pillow：解码 + EXIF
try:
    from PIL import Image, ImageOps
    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False

try:
    from pillow_heif import register_heif_opener
    HEIF_AVAILABLE = True
except ImportError:
    HEIF_AVAILABLE = False

# 复用现有解码逻辑作为回退
from utils.images import convert_to_opencv


def decode_image(image_bytes: bytes) -> Tuple[Optional[np.ndarray], Optional[str]]:
    """
    统一解码：支持 AVIF/HEIC/HEIF/JPEG/PNG/WebP，并处理 EXIF orientation。
    保证后续各模块拿到的是方向已校正的 BGR 图像。
    
    Args:
        image_bytes: 图片字节数据
    
    Returns:
        (image, error)
        - image: BGR numpy array (H, W, 3)，或 None
        - error: 错误信息字符串，或 None
    """
    if not image_bytes or len(image_bytes) == 0:
        return None, "图片数据为空"

    # 优先走 PIL 路径以便统一做 EXIF 校正
    if PILLOW_AVAILABLE:
        try:
            if HEIF_AVAILABLE:
                try:
                    register_heif_opener()
                except Exception:
                    pass
            pil = Image.open(io.BytesIO(image_bytes))
            if pil.mode != "RGB":
                pil = pil.convert("RGB")
            pil = ImageOps.exif_transpose(pil)
            rgb = np.array(pil)
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            logger.info("decode_image: PIL+EXIF 解码成功, shape=%s" % (bgr.shape,))
            return bgr, None
        except Exception as e:
            logger.info("decode_image: PIL 路径失败，回退 convert_to_opencv: %s" % (e,))

    # 回退到现有逻辑（无 EXIF 校正）
    image, error = convert_to_opencv(image_bytes)
    return image, error
