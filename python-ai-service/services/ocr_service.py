#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 服务
文字识别业务逻辑
"""

import cv2
import numpy as np
from logger import logger
from config import settings


def recognize_text(image):
    """识别图片中的文字"""
    try:
        from loaders.ocr_loader import get_ocr_model
        
        # 获取 OCR 模型
        paddle_ocr = get_ocr_model()
        if paddle_ocr is None:
            raise Exception("OCR 模型未加载")
        
        # PaddleOCR 识别
        result = paddle_ocr.ocr(image, cls=True)
        
        texts = []
        confidences = []
        segments = []
        
        if result and len(result) > 0:
            for line in result:
                if line:  # 确保line不为空
                    for item in line:
                        if len(item) >= 2 and isinstance(item[1], (list, tuple)):
                            text = item[1][0]
                            conf = float(item[1][1]) if len(item[1]) > 1 else 0.0
                            
                            if text and text.strip():  # 过滤空文本
                                texts.append(text.strip())
                                confidences.append(conf)
                                
                                # 构建segment信息
                                segment = {
                                    'text': text.strip(),
                                    'confidence': conf
                                }
                                
                                # 如果有边界框信息，也包含进去
                                if len(item) >= 1 and isinstance(item[0], (list, tuple)):
                                    segment['bbox'] = item[0]
                                    
                                segments.append(segment)
        
        # 合并所有文本
        joined_text = " ".join(texts).strip()
        avg_conf = (sum(confidences) / len(confidences)) if confidences else 0.0
        
        return {
            'text': joined_text,
            'confidence': avg_conf,
            'text_count': len(texts),
            'segments': segments
        }
        
    except Exception as e:
        logger.error(f"OCR识别失败: {str(e)}")
        raise
