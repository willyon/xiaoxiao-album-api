#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸识别模型加载器
统一管理所有人脸分析相关的 AI 模型
"""

import time
import insightface
import onnxruntime as ort
from emotiefflib.facial_analysis import EmotiEffLibRecognizerOnnx
from logger import logger
from config import settings


# ========== 全局变量存储所有模型 ==========
face_app = None              # InsightFace 模型（人脸检测+特征提取）
fairface_session = None      # FairFace ONNX 模型（年龄性别识别）
expression_model = None      # EmotiEffLib ONNX 模型（表情识别）
all_models_loaded = False    # 所有模型是否已加载


def load_all_models():
    """统一加载所有人脸分析模型
    
    包含的模型：
    1. InsightFace SCRFD - 人脸检测 + 特征提取（~2-3秒，~200MB）
    2. FairFace ONNX - 年龄性别识别（~1-2秒，~100MB）
    3. EmotiEffLib ONNX - 表情识别（~1-2秒，~50MB）
    
    优点：
    - 服务启动完成 = 所有功能可用
    - 避免第一次请求冷启动慢
    - 问题提前发现（启动时就知道模型是否有问题）
    
    异常处理:
    - GPU加载失败时自动回退到CPU
    - 任一模型加载失败都会抛出异常，阻止服务启动
    """
    global face_app, fairface_session, expression_model, all_models_loaded
    
    start_time = time.time()
    logger.info("🚀 开始加载所有AI模型...")
    
    try:
        # ========== 1. 加载 InsightFace（人脸检测+特征提取） ==========
        ctx_id = 0 if settings.USE_GPU else -1
        
        try:
            face_app = insightface.app.FaceAnalysis()
            face_app.prepare(ctx_id=ctx_id, det_size=settings.FACE_DET_SIZE)
            logger.info("  ✅ InsightFace SCRFD 已加载")
        except Exception as e:
            # GPU失败，尝试CPU
            if ctx_id != -1:
                logger.warning(f"  ⚠️ GPU加载失败，回退到CPU: {e}")
                face_app = insightface.app.FaceAnalysis()
                face_app.prepare(ctx_id=-1, det_size=settings.FACE_DET_SIZE)
                logger.info("  ✅ InsightFace SCRFD 已加载（CPU）")
            else:
                raise
        
        # ========== 2. 加载 FairFace ONNX（年龄性别识别） ==========
        model_path = "models/fairface.onnx"
        fairface_session = ort.InferenceSession(model_path)
        logger.info("  ✅ FairFace ONNX 已加载")
        
        # ========== 3. 加载 EmotiEffLib ONNX（表情识别） ==========
        expression_model = EmotiEffLibRecognizerOnnx(model_name="enet_b0_8_best_afew")
        logger.info("  ✅ EmotiEffLib ONNX 已加载")
        
        # ========== 完成 ==========
        all_models_loaded = True
        elapsed = time.time() - start_time
        logger.info(f"🎉 所有AI模型加载完成（耗时 {elapsed:.2f}秒）")
        
    except Exception as e:
        logger.error(f"❌ 模型加载失败: {e}", exc_info=True)
        all_models_loaded = False
        raise


def get_insightface_model():
    """获取 InsightFace 模型（人脸检测+特征提取）"""
    if not all_models_loaded:
        load_all_models()
    return face_app


def get_fairface_session():
    """获取 FairFace ONNX 模型（年龄性别识别）"""
    if not all_models_loaded:
        load_all_models()
    return fairface_session


def get_expression_model():
    """获取 EmotiEffLib ONNX 模型（表情识别）"""
    if not all_models_loaded:
        load_all_models()
    return expression_model


def all_face_models_loaded():
    """检查所有人脸模型是否已加载
    
    用途:
    - 健康检查接口调用
    - 监控服务状态
    
    返回值:
    - True: 所有人脸模型已加载并可用（InsightFace + FairFace + EmotiEffLib）
    - False: 模型未加载或加载失败
    """
    return all_models_loaded
