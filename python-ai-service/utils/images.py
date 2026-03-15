#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图像处理工具 - 支持 AVIF/HEIC/HEIF 等现代图片格式
专注于图片格式转换的核心功能
"""

import cv2
import numpy as np
from logger import logger

# pillow-heif：用于 HEIC/HEIF 格式
try:
    from pillow_heif import read_heif
    HEIF_AVAILABLE = True
except ImportError:
    HEIF_AVAILABLE = False
    logger.warning("pillow-heif 未安装，HEIC/HEIF 格式将不被支持。安装命令: pip install pillow-heif")

# Pillow：用于 AVIF 格式（Pillow 11+ 原生支持）
try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False
    logger.warning("Pillow 未安装，AVIF 等格式将不被支持")


def _detect_image_format(image_bytes):
    """
    通过文件头（magic bytes）检测图片格式
    
    Args:
        image_bytes: 图片字节数据
    
    Returns:
        str: 图片格式 ('jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'unknown')
    """
    if len(image_bytes) < 12:
        return 'unknown'
    
    # JPEG: FF D8 FF
    if image_bytes[0:3] == b'\xff\xd8\xff':
        return 'jpeg'
    
    # PNG: 89 50 4E 47 0D 0A 1A 0A
    if image_bytes[0:8] == b'\x89\x50\x4e\x47\x0d\x0a\x1a\x0a':
        return 'png'
    
    # WebP: RIFF ... WEBP
    if image_bytes[0:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        return 'webp'
    
    # HEIC/HEIF/AVIF: ftyp (位于偏移4)
    if image_bytes[4:8] == b'ftyp':
        # 检查具体的品牌类型（brand）
        brand = image_bytes[8:12]
        
        # HEIC 格式（Apple HEVC 图片）
        if brand in (b'heic', b'heix', b'hevc', b'hevx', b'heim', b'heis', b'hevm', b'hevs'):
            return 'heic'
        
        # HEIF 格式（通用 HEIF）
        elif brand in (b'mif1', b'msf1'):
            return 'heif'
        
        # AVIF 格式（AV1 图片）
        elif brand in (b'avif', b'avis', b'MA1A', b'MA1B'):
            return 'avif'
        
        # 未知的 ftyp 容器格式（可能是其他变种）
        # 返回 unknown，让降级机制处理
        logger.info("检测到未知的 ftyp brand: %s" % brand)
    
    return 'unknown'


def convert_to_opencv(image_bytes):
    """
    将图片字节数据转换为OpenCV格式
    
    支持格式：
    - 常规格式：JPEG, PNG, WebP, BMP, TIFF（OpenCV 原生支持）
    - HEIC/HEIF：通过 pillow-heif 解码
    - AVIF：通过 Pillow 解码
    
    优化策略：
    1. 先检测图片格式（通过文件头）
    2. 根据格式选择最佳解码器，避免不必要的尝试
    3. 如果检测失败或解码失败，降级到其他解码器
    
    Args:
        image_bytes: 图片字节数据
    
    Returns:
        tuple: (image, error)
            - image: OpenCV格式图片(BGR, numpy array) 或 None
            - error: 错误信息字符串 或 None
    """
    try:
        # 1. 检测图片格式
        image_format = _detect_image_format(image_bytes)
        logger.info(f"检测到图片格式: {image_format}")
        
        # 2. 根据格式选择最佳解码器（每个分支独立处理，成功返回，失败报错）
        # 顺序：AVIF > HEIC/HEIF > JPEG/PNG/WebP > unknown（按出现频率排序）
        
        # AVIF 格式 → 使用 Pillow（高清压缩图，最常见）
        if image_format == 'avif':
            if not PILLOW_AVAILABLE:
                error_msg = "检测到 AVIF 格式，但 Pillow 未安装"
                logger.error(error_msg)
                return None, error_msg
            
            try:
                import io
                pil_image = Image.open(io.BytesIO(image_bytes))
                if pil_image.mode != 'RGB':
                    pil_image = pil_image.convert('RGB')
                rgb_array = np.array(pil_image)
                bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
                logger.info(f"✅ Pillow 解码 AVIF 成功: {bgr_array.shape}")
                return bgr_array, None
            except Exception as pillow_error:
                error_msg = f"AVIF 格式解码失败: {str(pillow_error)}"
                logger.error(error_msg)
                return None, error_msg
        
        # HEIC/HEIF 格式 → 使用 pillow-heif（iPhone 原图）
        elif image_format in ('heic', 'heif'):
            if not HEIF_AVAILABLE:
                error_msg = f"检测到 {image_format.upper()} 格式，但 pillow-heif 未安装"
                logger.error(error_msg)
                return None, error_msg
            
            try:
                heif_file = read_heif(image_bytes)
                rgb_array = np.array(heif_file)
                bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
                logger.info(f"✅ pillow-heif 解码 {image_format.upper()} 成功: {bgr_array.shape}")
                return bgr_array, None
            except Exception as heif_error:
                error_msg = f"{image_format.upper()} 格式解码失败: {str(heif_error)}"
                logger.error(error_msg)
                return None, error_msg
        
        # JPEG/PNG/WebP 等常规格式 → 使用 OpenCV
        elif image_format in ('jpeg', 'png', 'webp'):
            image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
            if image is not None:
                logger.info(f"✅ OpenCV 解码 {image_format.upper()} 成功: {image.shape}")
                return image, None
            else:
                error_msg = f"{image_format.upper()} 格式解码失败（OpenCV 返回 None）"
                logger.error(error_msg)
                return None, error_msg
        
        # 未知格式 → 尝试多种解码器
        elif image_format == 'unknown':
            logger.info("格式未知，尝试多种解码器")
            
            # 1. 先尝试 OpenCV（最快，支持最常见格式）
            image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
            if image is not None:
                logger.info(f"✅ OpenCV 解码未知格式成功: {image.shape}")
                return image, None
            
            # 2. 尝试 Pillow（通用性最强）
            if PILLOW_AVAILABLE:
                try:
                    import io
                    pil_image = Image.open(io.BytesIO(image_bytes))
                    if pil_image.mode != 'RGB':
                        pil_image = pil_image.convert('RGB')
                    rgb_array = np.array(pil_image)
                    bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
                    logger.info(f"✅ Pillow 解码未知格式成功: {bgr_array.shape}")
                    return bgr_array, None
                except Exception as pillow_error:
                    logger.info("Pillow 解码失败: %s" % pillow_error)
            
            # 3. 尝试 pillow-heif（可能是未识别的 HEIC 变种）
            if HEIF_AVAILABLE:
                try:
                    heif_file = read_heif(image_bytes)
                    rgb_array = np.array(heif_file)
                    bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
                    logger.info(f"✅ pillow-heif 解码未知格式成功: {bgr_array.shape}")
                    return bgr_array, None
                except Exception as heif_error:
                    logger.info("pillow-heif 解码失败: %s" % heif_error)
            
            # 所有解码器都失败
            error_msg = "图片格式不支持：所有解码器均无法识别"
            logger.error(error_msg)
            return None, error_msg
        
        # 兜底：不应该走到这里
        else:
            error_msg = f"未处理的图片格式: {image_format}"
            logger.error(error_msg)
            return None, error_msg
        
    except Exception as e:
        error_msg = f"图片处理失败: {str(e)}"
        logger.error(error_msg)
        return None, error_msg
