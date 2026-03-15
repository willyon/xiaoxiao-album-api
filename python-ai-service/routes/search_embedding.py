#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
搜索向量化接口
提供文本编码、图像编码和向量相似度搜索功能
"""

import cv2
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from typing import List, Optional

from config import normalize_profile
from constants.error_codes import AI_DEVICE_NOT_SUPPORTED, AI_SERVICE_ERROR, IMAGE_DECODE_FAILED, INVALID_REQUEST
from logger import logger
from schemas.error_schema import ErrorBody
from services.text_embedding_service import encode_text
from services.vector_search_service import ann_search
from services.siglip_embedding_service import compute_siglip_embedding
from utils.device import normalize_device
from utils.image_decode import decode_image

router = APIRouter()


class EncodeTextRequest(BaseModel):
    """文本编码请求"""
    text: str


class EncodeTextResponse(BaseModel):
    """文本编码响应"""
    vector: List[float]
    model: str


class VectorSearchResponse(BaseModel):
    """向量搜索响应"""
    results: List[dict]  # [{"media_id": int, "score": float}]


class AnnSearchRequest(BaseModel):
    """ANN 向量搜索请求（基于 hnswlib 索引）"""
    user_id: int
    query_vector: List[float]
    top_k: int = 50


@router.post("/encode_text", response_model=EncodeTextResponse)
async def encode_text_endpoint(request: EncodeTextRequest):
    """
    将文本编码为向量
    
    参数:
    - text: 要编码的文本字符串
    
    返回:
    - vector: 1152 维向量
    - model: 模型 ID（"siglip2"）
    """
    if not request.text or not request.text.strip():
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=INVALID_REQUEST, error_message="文本不能为空").dict(),
        )

    try:
        result = encode_text(request.text)

        if result is None:
            raise HTTPException(
                status_code=500,
                detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="文本编码失败").dict(),
            )
        
        return EncodeTextResponse(
            vector=result["vector"],
            model=result["model"]
        )
        
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("文本编码接口失败", details={"error": str(exc), "text": request.text[:50]})
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=f"文本编码失败: {str(exc)}").dict(),
        ) from exc


@router.post("/encode_image", response_model=EncodeTextResponse)
async def encode_image_endpoint(
    image: UploadFile = File(..., max_size=50 * 1024 * 1024),
    profile: str = Form("standard"),
    device: str = Form("auto"),
):
    """
    将图片编码为向量（与 /encode_text 对称，仅负责图像 → 向量）。
    入参: multipart/form-data 的 image（必填）、profile、device。
    返回: { "vector": number[], "model": "siglip2" }
    """
    profile = normalize_profile(profile)
    resolved, err = normalize_device(device)
    if err:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=err or AI_DEVICE_NOT_SUPPORTED, error_message="设备参数无效或不可用").dict(),
        )
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message="图片数据为空").dict(),
        )
    img_bgr, decode_err = decode_image(image_bytes)
    if decode_err or img_bgr is None:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=IMAGE_DECODE_FAILED, error_message=decode_err or "图片解码失败").dict(),
        )
    rgb_image = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    result = compute_siglip_embedding(rgb_image, profile=profile)
    if result is None or not result.get("vector"):
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message="图像编码失败").dict(),
        )
    return EncodeTextResponse(vector=result["vector"], model=result.get("model", "siglip2"))


@router.post("/ann_search_by_vector", response_model=VectorSearchResponse)
async def ann_search_by_vector_endpoint(request: AnnSearchRequest):
    """
    基于 hnswlib ANN 索引的向量搜索
    """
    if not request.query_vector:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(error_code=INVALID_REQUEST, error_message="查询向量不能为空").dict(),
        )

    if len(request.query_vector) != 1152:
        raise HTTPException(
            status_code=400,
            detail=ErrorBody(
                error_code=INVALID_REQUEST,
                error_message=f"查询向量维度错误，期望 1152，实际 {len(request.query_vector)}",
            ).dict(),
        )

    try:
        results = ann_search(
            user_id=request.user_id,
            query_vector=request.query_vector,
            top_k=request.top_k,
        )
        return VectorSearchResponse(results=results)
    except Exception as exc:
        logger.error("ANN 向量搜索接口失败", details={"error": str(exc)})
        raise HTTPException(
            status_code=500,
            detail=ErrorBody(error_code=AI_SERVICE_ERROR, error_message=f"向量搜索失败: {str(exc)}").dict(),
        ) from exc
