#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI图片分析服务
使用 InsightFace + DeepFace + PaddleOCR以及千问大模型进行高精度图片分析
功能：人脸识别、OCR文字识别、人脸聚类、图片内容理解
"""

import uvicorn                                    # ASGI 服务器，用于运行 FastAPI 应用
from fastapi import FastAPI                       # FastAPI 框架，用于构建 Web API
from config import settings                        # 应用配置，包含所有环境变量设置
from logger import logger                          # 日志记录器，用于记录应用日志

# 导入路由模块
from routes import health, face, ocr, face_cluster     # 导入各个 API 路由：健康检查、人脸识别、OCR、人脸聚类

# 导入模型加载器
from loaders.face_loader import load_all_models    # 统一加载所有AI模型


def create_app():
    """创建 FastAPI 应用"""
    app = FastAPI(
        title="AI图片分析服务",
        description="使用 InsightFace + DeepFace + PaddleOCR以及千问大模型进行高精度图片分析",
        version="1.0.0"
    )
    
    # 增加文件上传大小限制 (50MB)
    from fastapi import Request
    from fastapi.middleware import Middleware
    from fastapi.middleware.cors import CORSMiddleware
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    
    # 启动时加载所有AI模型（人脸检测、年龄性别、表情）
    try:
        load_all_models()
    except Exception as e:
        logger.warning(f"启动时AI模型加载失败，将在首次请求时重试: {str(e)}")
    
    # 注册路由
    app.include_router(health.router, tags=["健康检查"])
    app.include_router(face.router, tags=["人脸识别"])
    app.include_router(ocr.router, tags=["OCR识别"])
    app.include_router(face_cluster.router, tags=["人脸聚类"])
    
    return app


def main():
    """主函数"""
    try:
        # 创建应用
        app = create_app()
        
        # 启动服务
        logger.info("🚀 AI图片分析服务启动中...")
        logger.info(f"📡 服务地址: http://{settings.HOST}:{settings.PORT}")
        logger.info("🔍 可用接口:")
        logger.info("  - GET  /health - 健康检查")
        logger.info("  - POST /analyze_face - 人脸识别")
        # logger.info("  - POST /ocr - OCR文字识别")
        logger.info("  - POST /cluster_faces - 人脸聚类")
        
        # 启动服务器
        uvicorn.run(
            app,
            host=settings.HOST,
            port=settings.PORT,
            log_level="info"
        )
        
    except Exception as e:
        logger.error(f"服务启动失败: {str(e)}")
        raise


if __name__ == '__main__':
    main()
