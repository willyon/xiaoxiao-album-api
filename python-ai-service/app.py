#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI图片分析服务
使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 等进行高精度图片分析
功能：人物分析（人脸+人体检测）、人脸聚类、图片内容理解

说明：
- 早期版本采用「严格模式」：启动时一次性加载所有关键模型，任一失败即阻止启动
- 当前版本改为：启动阶段不强制全量加载，由各能力按需懒加载并通过 ModelManager 与模型注册表管理
"""

import os
import time
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import HTTPException as FastAPIHTTPException

from config import settings
from logger import logger

# 导入路由模块
from routes import caption, cleanup, face_cluster, health, objects, ocr, person, scene, search_embedding

# 导入向量索引与 ModelManager
from services.vector_search_service import init_hnsw_index  # 向量搜索索引初始化
from services.model_manager import get_model_manager  # 按能力+profile+device 管理模型，供路由与 health 使用
from services.model_registry import MODEL_CONFIGS, resolve_local_path


def _setup_model_cache_env() -> None:
    """
    在导入可能触发模型下载的库之前，统一将第三方缓存目录重定向到项目内 models/cache/*。
    - HuggingFace 生态：HF_HOME / TRANSFORMERS_CACHE / HUGGINGFACE_HUB_CACHE → models/cache/hf
    - PaddleOCR：PADDLEOCR_HOME → models/cache/paddleocr
    - InsightFace：INSIGHTFACE_HOME → models/cache/insightface
    """
    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))  # python-ai-service 根目录
        models_dir = os.path.join(base_dir, "models")

        hf_cache = os.path.join(models_dir, "cache", "hf")
        paddle_cache = os.path.join(models_dir, "cache", "paddleocr")
        insight_cache = os.path.join(models_dir, "cache", "insightface")

        for path in (hf_cache, paddle_cache, insight_cache):
            try:
                os.makedirs(path, exist_ok=True)
            except Exception:
                # 目录创建失败不阻塞启动，后续加载会自行报错
                pass

        os.environ.setdefault("HF_HOME", hf_cache)
        os.environ.setdefault("TRANSFORMERS_CACHE", hf_cache)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", hf_cache)

        os.environ.setdefault("PADDLEOCR_HOME", paddle_cache)
        os.environ.setdefault("INSIGHTFACE_HOME", insight_cache)
    except Exception:
        # 环境变量设置失败不阻塞服务启动，具体模型加载时会再暴露问题
        pass


# 在创建应用前尽早设置缓存目录环境变量
_setup_model_cache_env()


def create_app():
    """创建 FastAPI 应用"""
    app = FastAPI(
        title="AI图片分析服务",
        description="使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 等模型进行高精度图片分析。",
        version="2.2.0",
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

    # 统一结构化接口日志：对核心推理接口在响应后打一行 endpoint/profile/device/latency/result_count/error_code
    ANALYSIS_LOG_PATHS = {
        "/analyze_caption",
        "/analyze_objects",
        "/analyze_scene",
        "/ocr",
        "/analyze_cleanup",
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
            "profile": getattr(state, "_log_profile", None),
            "requested_device": getattr(state, "_log_requested_device", None),
            "resolved_device": getattr(state, "_log_resolved_device", None),
            "model_name": getattr(state, "_log_model_name", None),
            "latency_ms": latency_ms,
            "result_count": getattr(state, "_log_result_count", None),
            "error_code": getattr(state, "_log_error_code", None),
            "status_code": response.status_code,
        }
        if getattr(state, "_log_image_size", None):
            log_payload["image_size"] = state._log_image_size
        logger.info("request_end", details=log_payload)
        return response
    # 启动阶段不再强制全量加载所有 AI 模型
    # 各能力相关模型由 ModelManager / loaders 按需懒加载，并基于模型注册表进行路由

    # 加载向量搜索索引（非严格依赖：失败时仅禁用 ANN，仍可使用 FTS 等功能）
    try:
        init_hnsw_index()
    except Exception as e:
        logger.error("向量索引初始化失败，向量搜索将退化为 FTS", details={"error": str(e)})

    # 初始化全局 ModelManager（委托现有 loader，供路由与 /health 使用）
    manager = get_model_manager()
    logger.info("✅ ModelManager 已初始化")

    # 启动预热：仅加载注册表中标记为 preload 的模型
    @app.on_event("startup")
    async def preload_models():
        logger.info("🚀 启动预热：开始加载 preload 模型（注册表驱动）")

        strict = bool(getattr(settings, "STRICT_PRELOAD", False))
        required_raw = getattr(settings, "STRICT_PRELOAD_REQUIRED_MODEL_IDS", "") or ""
        required_ids = {x.strip() for x in required_raw.split(",") if x.strip()}

        # 若未指定 required_ids 且开启 strict，则默认所有 preload 都必须成功
        def _is_required(model_id: str) -> bool:
            if not strict:
                return False
            if required_ids:
                return model_id in required_ids
            return True

        failures: list[dict] = []

        def _record_fail(mid: str, exc: Exception):
            failures.append({"model_id": mid, "error": str(exc)})
            logger.error("preload 失败", details={"model_id": mid, "error": str(exc)})

        for model_id, cfg in MODEL_CONFIGS.items():
            if (cfg.load_strategy or "").lower() != "preload":
                continue
            try:
                task = (cfg.task_type or "").lower()
                scope_profile = (cfg.profile_scope or "standard").lower()

                if task == "face":
                    from loaders.model_loader import get_insightface_model

                    get_insightface_model()
                elif task == "ocr":
                    from loaders.ocr_loader import get_ocr_model

                    get_ocr_model()
                elif task == "object":
                    # object preload 只对 standard（或 shared）有意义；enhanced 默认为 lazy
                    manager.get_object_model(scope_profile if scope_profile != "shared" else "standard", settings.DEFAULT_DEVICE)
                elif task == "image_embedding":
                    from loaders.model_loader import get_siglip2_components_for_path

                    get_siglip2_components_for_path(resolve_local_path(cfg.local_path))
                elif task == "cleanup":
                    from loaders.model_loader import get_aesthetic_head_session

                    get_aesthetic_head_session()
                else:
                    # 未映射的 task_type：暂不自动 preload
                    logger.info("preload.skip: 未支持的 task_type=%s", task, extra={"model_id": model_id})
            except Exception as e:  # pragma: no cover
                _record_fail(model_id, e)
                if _is_required(model_id):
                    raise RuntimeError(f"preload required model failed: {model_id}: {e}") from e

        logger.info(
            "✅ 启动预热：preload 模型加载完成",
            extra={"failures": failures, "strict": strict, "required_ids": list(required_ids)},
        )

    # 注册路由
    app.include_router(health.router, tags=["健康检查"])
    app.include_router(caption.router, tags=["Caption"])
    app.include_router(objects.router, tags=["物体检测"])
    app.include_router(scene.router, tags=["场景分类"])
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
        logger.info("  - POST /analyze_caption - Caption 分析")
        logger.info("  - POST /analyze_objects - 物体检测")
        logger.info("  - POST /analyze_scene - 场景分类")
        logger.info("  - POST /analyze_person - 人物分析（人脸+人体检测）")
        logger.info("  - POST /analyze_cleanup - 图片清理指标")
        logger.info("  - POST /ocr - OCR 文字识别")
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
        logger.error("服务启动失败", details={"error": str(e)})
        raise


if __name__ == '__main__':
    main()
