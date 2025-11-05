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
yolov11x_session = None      # YOLOv11x ONNX 模型（人体检测）
all_models_loaded = False    # 所有模型是否已加载


def load_all_models():
    """统一加载所有视觉分析模型
    
    模型列表（严格模式 - 所有模型必须加载成功）：
    【组A：人脸识别】
    1. InsightFace SCRFD - 人脸检测 + 特征提取（~2-3秒，~200MB）
    2. FairFace ONNX - 年龄性别识别（~1-2秒，~100MB）
    3. EmotiEffLib ONNX - 表情识别（~1-2秒，~50MB）
    
    【组B：人体检测】
    4. YOLOv11x - 人体检测（~1-2秒，~200MB）
    
    异常处理策略（严格模式）：
    - 所有模型加载失败都将抛出异常，阻止服务启动
    - GPU 加载失败时自动回退到 CPU
    - 确保数据完整性，避免产生不完整的分析结果
    """
    global face_app, fairface_session, expression_model, yolov11x_session, all_models_loaded
    
    start_time = time.time()
    logger.info("🚀 开始加载所有AI模型...")
    
    # ========== 组A：人脸识别模型组 ==========
    logger.info("📦 加载人脸识别模型组...")
    
    # 获取 ONNX Runtime 执行提供者
    onnx_providers = settings.get_onnx_providers()
    logger.info(f"🔧 ONNX Runtime 执行提供者: {onnx_providers}")
    
    # 1. 加载 InsightFace（人脸检测+特征提取）【必须成功】
    ctx_id = 0 if settings.USE_GPU else -1
    
    try:
        face_app = insightface.app.FaceAnalysis(providers=onnx_providers)
        face_app.prepare(ctx_id=ctx_id, det_size=settings.FACE_DET_SIZE)
        logger.info("  ✅ InsightFace SCRFD 已加载")
    except Exception as e:
        # GPU失败，尝试CPU
        if ctx_id != -1:
            logger.warning(f"  ⚠️ GPU加载失败，回退到CPU: {e}")
            try:
                face_app = insightface.app.FaceAnalysis(providers=['CPUExecutionProvider'])
                face_app.prepare(ctx_id=-1, det_size=settings.FACE_DET_SIZE)
                logger.info("  ✅ InsightFace SCRFD 已加载（CPU）")
            except Exception as cpu_error:
                logger.error(f"  ❌ InsightFace 加载失败（GPU和CPU都失败）")
                raise RuntimeError(f"InsightFace 模型加载失败: {cpu_error}") from cpu_error
        else:
            logger.error(f"  ❌ InsightFace 加载失败")
            raise RuntimeError(f"InsightFace 模型加载失败: {e}") from e
    
    # 2. 加载 FairFace ONNX（年龄性别识别）【必须成功】
    try:
        model_path = "models/fairface.onnx"
        fairface_session = ort.InferenceSession(model_path, providers=onnx_providers)
        logger.info("  ✅ FairFace ONNX 已加载")
    except Exception as e:
        logger.error(f"  ❌ FairFace ONNX 加载失败")
        raise RuntimeError(f"FairFace 模型加载失败: {e}") from e
    
    # 3. 加载 EmotiEffLib ONNX（表情识别）【必须成功】
    try:
        expression_model = EmotiEffLibRecognizerOnnx(model_name="enet_b0_8_best_afew")
        logger.info("  ✅ EmotiEffLib ONNX 已加载")
    except Exception as e:
        logger.error(f"  ❌ EmotiEffLib ONNX 加载失败")
        raise RuntimeError(f"EmotiEffLib 模型加载失败: {e}") from e
    
    logger.info("✅ 人脸识别模型组加载完成")
    
    # ========== 组B：人体检测模型组 ==========
    logger.info("📦 加载人体检测模型组...")
    
    # 4. 加载 YOLOv11x ONNX（人体检测）【必须成功】
    try:
        model_path = "models/yolo11x.onnx"
        yolov11x_session = ort.InferenceSession(model_path, providers=onnx_providers)
        logger.info("  ✅ YOLOv11x ONNX 已加载")
    except Exception as e:
        logger.error(f"  ❌ YOLOv11x ONNX 加载失败")
        raise RuntimeError(f"YOLOv11x 模型加载失败: {e}") from e
    
    logger.info("✅ 人体检测模型组加载完成")
    
    # ========== 完成 ==========
    all_models_loaded = True
    elapsed = time.time() - start_time
    
    # 所有模型必须加载成功（严格模式）
    all_ok = (face_app is not None and 
              fairface_session is not None and 
              expression_model is not None and
              yolov11x_session is not None)
    
    logger.info(f"🎉 所有AI模型加载完成（耗时 {elapsed:.2f}秒）")
    logger.info(f"   ✅ InsightFace (人脸检测+特征提取)")
    logger.info(f"   ✅ FairFace (年龄性别识别)")
    logger.info(f"   ✅ EmotiEffLib (表情识别)")
    logger.info(f"   ✅ YOLOv11x (人体检测)")
    logger.info(f"   📊 所有模型状态: {'✅ 完全就绪' if all_ok else '❌ 异常'}")


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
    """获取 YOLOv11x ONNX 模型（人体检测）"""
    if not all_models_loaded:
        load_all_models()
    return yolov11x_session


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
