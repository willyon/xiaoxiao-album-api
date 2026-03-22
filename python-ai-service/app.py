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

import time
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import HTTPException as FastAPIHTTPException

from config import settings
from logger import logger

# 导入路由模块
from routes import analyze_full, caption, quality, face_cluster, health, person

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

    # 统一结构化接口日志：在路由 handler **返回响应对象之后**执行（故晚于 analyze_full_return_preview），
    # 只含 endpoint/latency/状态摘要，不含 modules 全文
    ANALYSIS_LOG_PATHS = {
        "/analyze_full",
        "/analyze_caption",
        "/analyze_quality",
        "/analyze_person",
    }

    @app.middleware("http")
    async def request_log_middleware(request: Request, call_next):
        request.state._log_start = time.perf_counter()
        response = await call_next(request)
        if request.url.path not in ANALYSIS_LOG_PATHS:
            return response
        latency_ms = round((time.perf_counter() - getattr(request.state, "_log_start", 0)) * 1000)
        state = request.state
        log_payload = {
            "endpoint": request.url.path,
            "requested_device": getattr(state, "_log_requested_device", None),
            "resolved_device": getattr(state, "_log_resolved_device", None),
            "model_name": getattr(state, "_log_model_name", None),
            "configured_provider": getattr(state, "_log_configured_provider", None),
            "resolved_provider": getattr(state, "_log_resolved_provider", None),
            "configured_vendor": getattr(state, "_log_configured_vendor", None),
            "resolved_vendor": getattr(state, "_log_resolved_vendor", None),
            "caption_status": getattr(state, "_log_caption_status", None),
            "top_status": getattr(state, "_log_top_status", None),
            "latency_ms": latency_ms,
            "result_count": getattr(state, "_log_result_count", None),
            "error_code": getattr(state, "_log_error_code", None),
            "status_code": response.status_code,
        }
        if getattr(state, "_log_image_size", None):
            log_payload["image_size"] = state._log_image_size
        logger.info("request_end", details=log_payload)
        return response
    # 注册路由
    app.include_router(health.router, tags=["健康检查"])
    app.include_router(analyze_full.router, tags=["全量分析"])
    app.include_router(caption.router, tags=["Caption"])
    app.include_router(person.router, tags=["人物分析"])
    app.include_router(face_cluster.router, tags=["人脸聚类"])
    app.include_router(quality.router, tags=["图片质量"])
    
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
        logger.info("  - POST /analyze_caption - 图片描述（caption）分析")
        logger.info("  - POST /analyze_person - 人物分析（人脸+人体检测）")
        logger.info("  - POST /analyze_quality - 图片质量指标")
        logger.info("  - POST /analyze_full - 全量图片分析（统一入口）")
        logger.info("  - POST /cluster_faces - 人脸聚类")
        
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
