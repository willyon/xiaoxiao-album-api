#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人物分析路由
功能：人脸识别（年龄/性别/表情）+ 人体检测（YOLOv11x + RTMW姿态估计）
专注于HTTP请求/响应处理
"""

from fastapi import APIRouter, UploadFile, File, HTTPException
from services.person_analysis_service import process_image_from_bytes
from logger import logger


# 创建路由器
router = APIRouter()


@router.post('/analyze_person')
async def analyze_person(image: UploadFile = File(..., max_size=50*1024*1024)):  # 50MB限制
    """分析图片中的人物（包括人脸和人体检测）
    
    Args:
        image (UploadFile): 上传的图片文件，通过 multipart/form-data 格式传输
                          - File(...) 表示这是一个必需的文件参数
                          - UploadFile 是 FastAPI 的文件上传类型，包含文件名、内容类型等信息
                          - 用户需要以 POST 请求发送图片文件到此接口
    
    Returns:
        dict: 人物分析结果，包含人脸数量、人物数量、年龄、性别、情绪等信息
        
    Raises:
        HTTPException: 
            - 400: 图片格式错误或处理失败
            - 500: 模型加载失败或人脸分析失败
    """
    try:
        # 1. 读取图片数据
        image_bytes = image.file.read()
        image_filename = image.filename or "unknown"
        
        # 记录图片文件名到日志
        logger.info(f"📷 开始处理图片: {image_filename}")
        
        # 2. 处理图片并分析人物（模型加载检查在service层自动处理）
        result = process_image_from_bytes(image_bytes)
        
        return result
        
    except HTTPException:
        raise
    except ValueError as e:
        # 图片格式问题
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # 其他业务异常
        logger.error(f"人物分析失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
