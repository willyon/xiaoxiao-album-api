#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图像处理工具 - 极简版
专注于图片格式转换的核心功能
"""

import cv2
import numpy as np


def convert_to_opencv(image_bytes):
    """将图片字节数据转换为OpenCV格式"""
    try:
        # 转换为 OpenCV 格式
        image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        
        if image is None:
            raise ValueError("图片格式转换失败")
        
        return image, None
        
    except Exception as e:
        return None, f"图片处理失败: {str(e)}"
