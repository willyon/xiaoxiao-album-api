#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI图片分析服务（严格模式）
使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 进行高精度图片分析
功能：人物分析（人脸+人体检测）、人脸聚类、图片内容理解

严格模式：所有模型必须加载成功，否则服务无法启动，确保数据完整性
"""

import uvicorn                                    # ASGI 服务器，用于运行 FastAPI 应用
from fastapi import FastAPI                       # FastAPI 框架，用于构建 Web API
from config import settings                        # 应用配置，包含所有环境变量设置
from logger import logger                          # 日志记录器，用于记录应用日志

# 导入路由模块
from routes import cleanup, face_cluster, health, ocr, person, search_embedding     # 导入各个 API 路由：健康检查、人物分析、OCR、人脸聚类、清理指标、搜索向量化

# 导入模型加载器
from loaders.model_loader import load_all_models    # 统一加载所有AI模型
from services.vector_search_service import init_hnsw_index  # 向量搜索索引初始化


def create_app():
    """创建 FastAPI 应用"""
    app = FastAPI(
        title="AI图片分析服务（严格模式）",
        description="使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 进行高精度图片分析。所有模型必须加载成功，确保数据完整性。",
        version="2.1.0"
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
    
    
    # 启动时加载所有AI模型（人脸检测、年龄性别、人体检测）
    # 严格模式：关键模型必须加载成功，否则阻止服务启动
    try:
        load_all_models()
        logger.info("✅ 所有关键模型加载成功，服务可以启动")
    except Exception as e:
        logger.error(f"❌ 模型加载失败，服务无法启动: {str(e)}")
        logger.error(f"💡 请检查模型文件是否完整：")
        logger.error(f"   - InsightFace 模型文件（~/.insightface/）")
        logger.error(f"   - models/fairface.onnx")
        logger.error(f"   - models/yolo11x.onnx")
        logger.error(f"   - EmotiEffLib 模型文件")
        raise RuntimeError(f"AI模型加载失败，服务无法启动: {str(e)}") from e

    # 加载向量搜索索引（非严格依赖：失败时仅禁用 ANN，仍可使用 FTS 等功能）
    try:
        init_hnsw_index()
    except Exception as e:
        logger.error(f"⚠️ 向量索引初始化失败，向量搜索将退化为 FTS: {str(e)}")
    
    # 注册路由
    app.include_router(health.router, tags=["健康检查"])
    app.include_router(person.router, tags=["人物分析"])
    app.include_router(ocr.router, tags=["OCR识别"])
    app.include_router(face_cluster.router, tags=["人脸聚类"])
    app.include_router(cleanup.router, tags=["智能清理"])
    app.include_router(search_embedding.router, tags=["搜索向量化"])
    
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
        logger.info("  - POST /analyze_person - 人物分析（人脸+人体检测）")
        logger.info("  - POST /analyze_cleanup - 图片清理指标")
        # logger.info("  - POST /ocr - OCR文字识别")
        logger.info("  - POST /cluster_faces - 人脸聚类")
        logger.info("  - POST /encode_text - 文本向量化")
        logger.info("  - POST /ann_search_by_vector - 向量相似度搜索（hnsw ANN）")
        
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
