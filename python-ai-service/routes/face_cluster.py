#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸聚类路由
专注于HTTP请求/响应处理，将业务逻辑委托给服务层
"""

from fastapi import APIRouter, HTTPException, Body, File, UploadFile, Form
from typing import List, Optional
import json

from config import settings
from constants.error_codes import (
    AI_SERVICE_ERROR,
    FACE_MODEL_MISSING,
    IMAGE_DECODE_FAILED,
    INVALID_REQUEST,
)
from logger import logger
from schemas.error_schema import ErrorBody
from services.cluster_service import ensure_model_loaded, perform_clustering
from services.person_analysis_service import _crop_face_thumbnail
from utils.image_decode import decode_image


# 创建路由器
# APIRouter: FastAPI的路由器，用于组织和管理API端点
router = APIRouter()


@router.post('/cluster_faces')
async def cluster_faces(
    # embeddings: 人脸特征向量列表（必需参数）
    # List[List[float]]: 二维数组，外层List包含多个人脸，内层List包含每个特征向量的数值
    # Body(...): 表示这个参数来自请求体，...表示必需参数（客户端必须提供）
    # description: API文档中的参数说明，帮助开发者理解参数用途
    # examples: 提供示例数据，展示正确的数据格式，便于测试和理解
    embeddings: List[List[float]] = Body(
        ...,  # 必需参数，客户端必须提供，否则返回400错误
        description="人脸特征向量列表，每个向量代表一个人脸。格式：二维数组，每个子数组是一个512维的特征向量",
        examples=[[[0.1, 0.2, 0.3, 0.4], [0.5, 0.6, 0.7, 0.8]]]  # 示例：两个人的简化特征向量
    ),
    
    # threshold: 聚类阈值（可选参数）
    # Optional[float]: 可选的浮点数类型，可以为None或具体的数值
    # Body(None): 默认值为None，如果客户端不提供则使用配置文件中的默认值
    # ge=0.1, le=2.0: 数据验证，确保阈值在0.1到2.0之间（ge=greater equal, le=less equal）
    threshold: Optional[float] = Body(
        None,  # 默认值为None，将使用配置文件中的 FACE_CLUSTERING_THRESHOLD（当前为0.42）
        description="聚类阈值（余弦距离），用于判断两个特征向量是否属于同一类。值越小聚类越严格，值越大聚类越宽松。推荐范围：0.3-0.6。如果不提供，将使用配置文件中的默认值",
        ge=0.1,   # 最小值：0.1，防止阈值过小导致过度分割
        le=2.0    # 最大值：2.0（余弦距离的最大值）
    )
):
    """人脸聚类API端点
    
    功能说明：
    - 接收人脸特征向量列表，将相似的人脸分组到同一聚类中
    - 使用DBSCAN聚类算法，根据特征向量之间的相似度进行分组
    - 返回聚类结果，每个聚类包含属于同一人的所有人脸索引
    
    Args:
        embeddings: 人脸特征向量列表，每个向量代表一个人脸
        threshold: 聚类阈值（可选，默认使用配置文件中的 FACE_CLUSTERING_THRESHOLD，当前为0.42，余弦距离）
                  值越小聚类越严格（同一人的不同照片可能被分到不同类）
                  值越大聚类越宽松（不同人的照片可能被分到同一类）
                  如果不提供此参数，将使用配置文件中的默认值
    
    Returns:
        dict: 聚类结果
            - clusters: 聚类列表，每个元素包含：
                - cluster_id: 聚类组ID（-1表示噪声点/孤立点）
                - face_indices: 属于该聚类的人脸索引列表
                - face_count: 该聚类中的人脸数量
        
    Raises:
        HTTPException: 
            - 400: 请求数据错误或缺少特征向量
            - 500: 模型加载失败或聚类处理失败
    """
    try:
        # 1. 确保模型已加载（模型检查在service层自动处理）
        # ensure_model_loaded(): 检查人脸识别模型是否已加载，如果未加载则自动加载
        if not ensure_model_loaded():
            raise HTTPException(
                status_code=500,
                detail=ErrorBody(error_code=FACE_MODEL_MISSING, error_message="人脸识别模型加载失败").dict(),
            )

        if not embeddings:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=INVALID_REQUEST, error_message="缺少特征向量").dict(),
            )
        
        # 如果未提供阈值，使用配置文件中的默认值
        # perform_clustering 函数会自动处理 None 值，使用配置文件中的默认阈值
        actual_threshold = threshold if threshold is not None else settings.FACE_CLUSTERING_THRESHOLD
        
        # 记录接收到的阈值（用于验证）
        logger.info(f"收到聚类请求: embedding数量={len(embeddings)}, 阈值={actual_threshold} (配置默认值: {settings.FACE_CLUSTERING_THRESHOLD})")
        
        # 3. 执行聚类（所有业务逻辑都在service层）
        # perform_clustering(): 调用聚类算法，将特征向量分组
        # 输入：特征向量列表和阈值（如果为None，将使用配置文件中的默认值）
        # 输出：聚类结果列表
        clusters = perform_clustering(embeddings, threshold)
        
        # 4. 返回聚类结果
        return {'clusters': clusters}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("人脸聚类失败", details={"error": str(e)})
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=str(e)).dict(),
        )


@router.post("/generate_face_thumbnail")
async def generate_face_thumbnail(
    image: UploadFile = File(..., description="图片文件"),
    bbox: str = Form(..., description="人脸边界框坐标，JSON格式: [x1, y1, x2, y2]")
):
    """
    生成人脸缩略图（用于聚类封面）
    
    优化（2025-12-XX）：只为聚类后的最佳人脸生成缩略图，减少99.5%的存储和CPU开销
    
    参数:
    - image: 图片文件（必需）
    - bbox: 人脸边界框坐标，JSON格式字符串 "[x1, y1, x2, y2]"
    
    返回:
    - face_thumbnail_base64: base64编码的缩略图，格式："data:image/jpeg;base64,..."
    
    Raises:
        HTTPException:
            - 400: 请求数据错误（图片为空、bbox格式错误等）
            - 500: 图片处理失败或缩略图生成失败
    """
    try:
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="图片数据为空").dict(),
            )

        try:
            bbox_list = json.loads(bbox)
            if not isinstance(bbox_list, list) or len(bbox_list) != 4:
                raise ValueError("bbox必须是包含4个元素的数组")
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=INVALID_REQUEST, error_message=f"bbox格式错误: {str(e)}").dict(),
            )

        image_data, decode_err = decode_image(image_bytes)
        if decode_err or image_data is None:
            raise HTTPException(
                status_code=400,
                detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
            )

        thumbnail_base64 = _crop_face_thumbnail(image_data, bbox_list)

        if thumbnail_base64 is None:
            raise HTTPException(
                status_code=500,
                detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="生成缩略图失败").dict(),
            )

        return {
            "success": True,
            "face_thumbnail_base64": thumbnail_base64
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("生成人脸缩略图失败", details={"error": str(e)})
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="生成缩略图失败").dict(),
        )
