#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 文字识别路由
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from services.ocr_service import recognize_text
from utils.images import convert_to_opencv
from loaders.ocr_loader import load_ocr_model, is_ocr_loaded
from logger import logger


# 创建路由器
router = APIRouter()


@router.post('/ocr')
async def ocr_recognize(image: UploadFile = File(...)):
    """OCR 文字识别"""
    try:
        # 确保 OCR 模型已加载
        if not is_ocr_loaded():
            load_ocr_model()
        
        if not is_ocr_loaded():
            raise HTTPException(status_code=500, detail='OCR模型未加载')

        # 读取并转换图片
        image_bytes = image.file.read()
        image_data, error = convert_to_opencv(image_bytes)
        if error:
            raise HTTPException(status_code=400, detail=error)

        # OCR 识别
        result = recognize_text(image_data)

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR识别失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
