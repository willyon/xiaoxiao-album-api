#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 模型统一加载器
统一管理所有视觉分析相关的 AI 模型

包含模型：
1. InsightFace - 人脸检测和特征提取
2. FairFace - 年龄和性别识别
3. EmotiEffLib - 表情识别
4. YOLOv11x - 人体检测（2025-10-27 新增，2025-11-01 升级）
5. RTMW-x - 姿态估计（2025-10-27 新增）
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
yolov11x_session = None       # YOLOv11x ONNX 模型（人体检测）
rtmw_session = None          # RTMW-x ONNX 模型（姿态估计，2025-10-27 新增）
all_models_loaded = False    # 所有模型是否已加载


def load_all_models():
    """统一加载所有视觉分析模型
    
    模型分组：
    【组A：人脸识别】独立运行，互不依赖
    1. InsightFace SCRFD - 人脸检测 + 特征提取（~2-3秒，~200MB）
    2. FairFace ONNX - 年龄性别识别（~1-2秒，~100MB）
    3. EmotiEffLib ONNX - 表情识别（~1-2秒，~50MB）
    
    【组B：人体检测】独立运行，互不依赖
    4. YOLOv11x - 人体检测（~1-2秒，~200MB）
    5. RTMW-x - 姿态估计（~1-2秒，~100MB）
    
    异常处理策略：
    - 任何一组加载失败都不会阻止服务启动
    - GPU 加载失败时自动回退到 CPU
    - 加载失败只记录警告，服务继续运行
    - 实际使用时检查模型是否可用
    """
    global face_app, fairface_session, expression_model, yolov11x_session, rtmw_session, all_models_loaded
    
    start_time = time.time()
    logger.info("🚀 开始加载所有AI模型...")
    
    # ========== 组A：人脸识别模型组 ==========
    logger.info("📦 加载人脸识别模型组...")
    
    try:
        # 获取 ONNX Runtime 执行提供者
        onnx_providers = settings.get_onnx_providers()
        logger.info(f"🔧 ONNX Runtime 执行提供者: {onnx_providers}")
        
        # 1. 加载 InsightFace（人脸检测+特征提取）
        ctx_id = 0 if settings.USE_GPU else -1
        
        try:
            face_app = insightface.app.FaceAnalysis(providers=onnx_providers)
            face_app.prepare(ctx_id=ctx_id, det_size=settings.FACE_DET_SIZE)
            logger.info("  ✅ InsightFace SCRFD 已加载")
        except Exception as e:
            # GPU失败，尝试CPU
            if ctx_id != -1:
                logger.warning(f"  ⚠️ GPU加载失败，回退到CPU: {e}")
                face_app = insightface.app.FaceAnalysis(providers=['CPUExecutionProvider'])
                face_app.prepare(ctx_id=-1, det_size=settings.FACE_DET_SIZE)
                logger.info("  ✅ InsightFace SCRFD 已加载（CPU）")
            else:
                raise
        
        # 2. 加载 FairFace ONNX（年龄性别识别）
        model_path = "models/fairface.onnx"
        fairface_session = ort.InferenceSession(model_path, providers=onnx_providers)
        logger.info("  ✅ FairFace ONNX 已加载")
        
        # 3. 加载 EmotiEffLib ONNX（表情识别）
        expression_model = EmotiEffLibRecognizerOnnx(model_name="enet_b0_8_best_afew")
        logger.info("  ✅ EmotiEffLib ONNX 已加载")
        
        logger.info("✅ 人脸识别模型组加载完成")
        
    except Exception as e:
        logger.warning(f"⚠️ 人脸识别模型组加载失败（人脸功能将不可用）: {e}")
        face_app = None
        fairface_session = None
        expression_model = None
    
    # ========== 组B：人体检测模型组 ==========
    logger.info("📦 加载人体检测模型组...")
    
    try:
        # 4. 加载 YOLOv11x ONNX（人体检测）
        model_path = "models/yolo11x.onnx"
        yolov11x_session = ort.InferenceSession(model_path, providers=onnx_providers)
        logger.info("  ✅ YOLOv11x ONNX 已加载")
    except Exception as e:
        logger.warning(f"  ⚠️ YOLOv11x ONNX 加载失败（人体检测功能将不可用）: {e}")
        yolov11x_session = None
    
    try:
        # 5. 加载 RTMW-x ONNX（姿态估计）
        model_path = "models/rtmw-x.onnx"
        rtmw_session = ort.InferenceSession(model_path, providers=onnx_providers)
        logger.info("  ✅ RTMW-x ONNX 已加载（133关键点全身姿态）")
    except Exception as e:
        logger.warning(f"  ⚠️ RTMW-x ONNX 加载失败（姿态验证功能将不可用）: {e}")
        rtmw_session = None
    
    if yolov11x_session or rtmw_session:
        logger.info("✅ 人体检测模型组加载完成")
    else:
        logger.warning("⚠️ 人体检测模型组全部加载失败（人体检测功能将不可用）")
    
    # ========== 完成 ==========
    all_models_loaded = True
    elapsed = time.time() - start_time
    
    # 统计加载情况
    face_models_ok = face_app and fairface_session and expression_model
    person_models_ok = yolov11x_session is not None
    
    logger.info(f"🎉 AI模型加载完成（耗时 {elapsed:.2f}秒）")
    logger.info(f"   - 人脸识别: {'✅ 可用' if face_models_ok else '❌ 不可用'}")
    logger.info(f"   - 人体检测: {'✅ 可用' if person_models_ok else '❌ 不可用'}")


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


def get_yolov11x_session():
    """获取 YOLOv11x ONNX 模型（人体检测，可选）"""
    if not all_models_loaded:
        load_all_models()
    return yolov11x_session


def get_rtmw_session():
    """获取 RTMW-x ONNX 模型（姿态估计，可选）"""
    if not all_models_loaded:
        load_all_models()
    return rtmw_session


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
