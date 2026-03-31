#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI图片分析服务
使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 等进行高精度图片分析
功能：人物分析（人脸+人体检测）、人脸聚类、图片内容理解

说明：
- 本地模型均为懒加载：进程启动只初始化 ModelManager，首次请求对应能力时再加载 ONNX 等权重
"""

import os

# 必须在任何可能触发模型下载的 import 之前执行（routes → model_loader → insightface 等会读环境变量）
def _setup_model_cache_env() -> None:
    """
    在导入可能触发模型下载的库之前，统一将第三方缓存目录重定向到项目内 models/cache/*。
    - InsightFace：INSIGHTFACE_HOME → models/cache/insightface
    - EmotiEffLib：EFFLIB_HOME → models/cache/emotiefflib
    """
    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))  # python-ai-service 根目录
        models_dir = os.path.join(base_dir, "models")

        insight_cache = os.path.join(models_dir, "cache", "insightface")
        emotiefflib_cache = os.path.join(models_dir, "cache", "emotiefflib")

        for path in (insight_cache, emotiefflib_cache):
            try:
                os.makedirs(path, exist_ok=True)
            except Exception:
                pass

        os.environ["INSIGHTFACE_HOME"] = insight_cache

        if not os.environ.get("EFFLIB_HOME"):
            os.environ["EFFLIB_HOME"] = emotiefflib_cache
    except Exception:
        pass


_setup_model_cache_env()

import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import HTTPException as FastAPIHTTPException

from config import settings
from logger import logger

# 导入路由模块
from routes import analyze_image, analyze_video, face_cluster, health

# 导入 ModelManager
from services.model_manager import get_model_manager


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """生命周期：启动时仅创建 ModelManager；本地模型均在首次请求时懒加载。"""
    get_model_manager()
    logger.info("✅ ModelManager 已初始化（本地模型懒加载，无启动预热线程）")

    yield
    # --- shutdown (暂无) ---


def create_app():
    """创建 FastAPI 应用"""
    app = FastAPI(
        title="AI图片分析服务",
        description="使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 等模型进行高精度图片分析。",
        version="2.2.0",
        lifespan=_lifespan,
    )

    # 统一错误体：4xx/5xx 返回 { "error_code", "error_message }，便于 Node 写入 last_error
    @app.exception_handler(FastAPIHTTPException)
    async def http_exception_handler(request: Request, exc: FastAPIHTTPException):
        if isinstance(exc.detail, dict) and "error_code" in exc.detail:
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 注册路由
    app.include_router(health.router, tags=["健康检查"])
    app.include_router(analyze_image.router, tags=["图片分析"])
    app.include_router(analyze_video.router, tags=["视频分析"])
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
        logger.info("  - POST /analyze_image - 全量图片分析")
        logger.info("  - POST /analyze_video - 视频分析（抽帧聚合）")
        logger.info("  - POST /cluster_face_embeddings - 人脸 embedding 聚类")
        logger.info("  - POST /crop_face_thumbnail - 人脸缩略图裁剪")
        
        # 启动服务器
        uvicorn.run(
            app,
            host=settings.HOST,
            port=settings.PORT,
            log_level="info"
        )
        
    except Exception as e:
        logger.error("服务启动失败", details={"error": str(e)})
        raise


if __name__ == '__main__':
    main()
