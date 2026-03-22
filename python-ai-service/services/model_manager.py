#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ModelManager：按 capability + resolved_device 管理模型实例（注册表见 model_registry.registry_scope）
- 懒加载、并发锁、缓存复用（缓存 key：model_id 或 capability 相关元组 + device）
- 各 get_* 方法：能力关闭时返回 None；未实现的能力返回 None，由 pipeline 返回空结构
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Optional

from config import normalize_cloud_vendor, normalize_provider, settings
from logger import logger
from models.embedding_model import EmbeddingBundle, SiglipImageEmbeddingModel
from services.model_registry import (
    get_fallback_model_id,
    get_model_config,
    resolve_local_path,
    resolve_model_id,
)
from utils.device import resolve_device

_EMBEDDING_DEFAULT_MODEL_ID = "embedding.standard.siglip2.base"


class ModelManager:
    """
    统一模型管理：按能力提供 get_*_model(device)。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # LRU 缓存：key -> model instance（超过 MODEL_CACHE_LIMIT 会逐出最久未使用项）
        self._object_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._scene_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._face_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._quality_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._embedding_models: "OrderedDict[tuple, Any]" = OrderedDict()

    def _lru_limit(self) -> int:
        try:
            return max(0, int(getattr(settings, "MODEL_CACHE_LIMIT", 16)))
        except Exception:
            return 16

    def _touch(self, cache: "OrderedDict[tuple, Any]", key: tuple) -> None:
        try:
            cache.move_to_end(key)
        except Exception:
            pass

    def _put(self, cache: "OrderedDict[tuple, Any]", key: tuple, value: Any) -> None:
        cache[key] = value
        self._touch(cache, key)
        limit = self._lru_limit()
        if limit <= 0:
            return
        while len(cache) > limit:
            evicted_key, _ = cache.popitem(last=False)
            logger.info("LRU evict model", extra={"cache": id(cache), "key": str(evicted_key)})

    def _capability_enabled(self, capability: str) -> bool:
        return True

    def _resolve_device(self, device: str) -> str:
        return resolve_device(device or settings.DEFAULT_DEVICE)

    def _cloud_api_key(self, capability: str) -> str:
        if capability == "caption":
            return (getattr(settings, "CAPTION_CLOUD_API_KEY", "") or "").strip()
        return ""

    def _configured_cloud_vendor(self, capability: str) -> str:
        if capability == "caption":
            return ((getattr(settings, "CAPTION_CLOUD_VENDOR", "qwen") or "qwen").strip().lower())
        return "qwen"

    def _cloud_vendor(self, capability: str) -> str:
        if capability == "caption":
            return normalize_cloud_vendor(self._configured_cloud_vendor("caption"))
        return "qwen"

    def _cloud_model(self, capability: str) -> str:
        if capability == "caption":
            return (getattr(settings, "CAPTION_CLOUD_MODEL", "") or "").strip()
        return ""

    def _cloud_base_url(self, capability: str) -> str:
        if capability == "caption":
            return (getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "").strip()
        return ""

    def _provider_available(self, capability: str, resolved_provider: str) -> bool:
        provider = (resolved_provider or "").strip().lower()
        if provider == "off":
            return False
        if provider == "cloud":
            return bool(self._cloud_api_key(capability)) and bool(self._cloud_vendor(capability))
        return False

    def _caption_runtime_ready(self) -> bool:
        """Caption 是否可用（仅云 API：密钥 + vendor）。"""
        p = normalize_provider(getattr(settings, "CAPTION_PROVIDER", "cloud"))
        if p == "off":
            return False
        return self._provider_available("caption", "cloud")

    def get_object_model(self, device: str) -> Optional[Any]:
        """
        物体检测模型。与人体检测共用 YOLO。

        基于模型注册表解析 object 模型；同一 (model_id, device) 只加载一次并缓存。
        """
        if not self._capability_enabled("object"):
            return None
        with self._lock:
            resolved_device = self._resolve_device(device)

            primary_id = resolve_model_id("object")
            if not primary_id:
                logger.warning("get_object_model: 未找到 task_type=object 的模型配置")
                return None

            # 按 primary → fallback 顺序尝试加载
            candidate_ids = [primary_id]
            fb = get_fallback_model_id(primary_id)
            if fb and fb not in candidate_ids:
                candidate_ids.append(fb)

            from models.object_model import YoloObjectDetector

            last_error: Optional[Exception] = None
            for model_id in candidate_ids:
                cache_key = (model_id, resolved_device)
                if cache_key in self._object_models:
                    self._touch(self._object_models, cache_key)
                    return self._object_models[cache_key]

                cfg = get_model_config(model_id)
                if not cfg:
                    continue
                try:
                    detector = YoloObjectDetector(onnx_path=resolve_local_path(cfg.local_path))
                    # 简单检查 session 是否可用
                    if getattr(detector, "session", None) is None:
                        raise RuntimeError(f"YoloObjectDetector session is None for {cfg.local_path}")
                    self._put(self._object_models, cache_key, detector)
                    logger.info(
                        "get_object_model: 已加载 object 模型",
                        extra={"model_id": model_id, "path": cfg.local_path},
                    )
                    return detector
                except Exception as e:  # pragma: no cover
                    last_error = e
                    logger.warning(
                        "get_object_model: 加载模型失败，将尝试 fallback（若有）",
                        extra={"model_id": model_id, "error": str(e)},
                    )

            if last_error:
                logger.warning("get_object_model: 所有候选 object 模型加载失败: %s" % last_error)
            return None

    def get_scene_model(self, device: str) -> Optional[Any]:
        """
        场景分类能力已从主链路中移除。
        保留空实现，始终返回 None，避免旧代码误用时触发 ImportError。
        """
        logger.info("get_scene_model: scene capability has been deprecated, always returning None")
        return None

    def get_face_model(self, device: str) -> Optional[Any]:
        """人物分析模型（人脸 + 人体）；由 PersonAnalyzer 封装。"""
        if not self._capability_enabled("face"):
            return None
        with self._lock:
            key = ("face", self._resolve_device(device))
            if key in self._face_models:
                self._touch(self._face_models, key)
                return self._face_models.get(key)
            if key not in self._face_models:
                try:
                    from models.person_model import PersonAnalyzer

                    self._put(self._face_models, key, PersonAnalyzer())
                except Exception as e:
                    logger.warning("get_face_model: 初始化失败 %s" % e)
                    return None
            return self._face_models.get(key)

    def get_quality_model(self, device: str) -> Optional[Any]:
        """质量/审美模型（SigLIP + Aesthetic Head）；由 QualityAnalyzer 封装。"""
        if not self._capability_enabled("quality"):
            return None
        with self._lock:
            emb_id = resolve_model_id("image_embedding") or _EMBEDDING_DEFAULT_MODEL_ID
            key = (emb_id, self._resolve_device(device))
            if key in self._quality_models:
                self._touch(self._quality_models, key)
                return self._quality_models.get(key)
            if key not in self._quality_models:
                try:
                    from models.quality_model import QualityAnalyzer

                    self._put(self._quality_models, key, QualityAnalyzer())
                except Exception as e:
                    logger.warning("get_quality_model: 初始化失败 %s" % e)
                    return None
            return self._quality_models.get(key)

    def get_embedding_model(self, device: str) -> Optional[Any]:
        """
        Image embedding：SigLIP2 图像向量（与现有 1152 维向量兼容）。
        """
        if not self._capability_enabled("embedding"):
            return None
        with self._lock:
            resolved_device = self._resolve_device(device)
            emb_id = resolve_model_id("image_embedding") or _EMBEDDING_DEFAULT_MODEL_ID
            key = (emb_id, resolved_device)
            if key in self._embedding_models:
                self._touch(self._embedding_models, key)
                return self._embedding_models.get(key)
            if key not in self._embedding_models:
                try:
                    image_model = SiglipImageEmbeddingModel()
                    self._put(self._embedding_models, key, EmbeddingBundle(image_model=image_model))
                except Exception as e:
                    logger.warning("get_embedding_model: 初始化失败 %s" % e)
                    return None
            return self._embedding_models.get(key)

    def _safe_capability(self, getter, *args, **kwargs) -> bool:
        """健康检查用：单能力检测失败不抛异常，仅返回 False。"""
        try:
            return getter(*args, **kwargs) is not None
        except Exception:
            return False

    def capabilities_loaded(self) -> dict[str, bool]:
        """各能力是否已有可用模型（供 /health）。单能力加载失败仅记为未加载，不抛异常。"""
        face = self._safe_capability(self.get_face_model, "cpu")
        quality = self._safe_capability(self.get_quality_model, "cpu")
        caption = self._caption_runtime_ready()
        object_ = self._safe_capability(self.get_object_model, "cpu")
        scene = self._safe_capability(self.get_scene_model, "cpu")
        embedding = self._safe_capability(self.get_embedding_model, "cpu")
        return {
            "caption": caption,
            "object": object_,
            "scene": scene,
            "face": face,
            "quality": quality,
            "embedding": embedding,
        }

    def _caption_config(self) -> dict[str, Any]:
        """返回 caption 的配置态信息，不触发模型加载。"""
        caption_configured = getattr(settings, "CAPTION_PROVIDER", "cloud")
        caption_resolved = normalize_provider(caption_configured)
        caption_configured_vendor = self._configured_cloud_vendor("caption") if caption_resolved == "cloud" else None
        caption_resolved_vendor = self._cloud_vendor("caption") if caption_resolved == "cloud" else None

        return {
            "caption": {
                "configured_provider": caption_configured,
                "resolved_provider": caption_resolved,
                "configured_vendor": caption_configured_vendor,
                "resolved_vendor": caption_resolved_vendor,
                "enabled": caption_resolved != "off",
                "available": self._provider_available("caption", caption_resolved),
                "cloud_model": self._cloud_model("caption") if caption_resolved == "cloud" else None,
                "cloud_base_url": self._cloud_base_url("caption") if caption_resolved == "cloud" else None,
            },
        }

    def capabilities_configured(self) -> dict[str, Any]:
        """返回配置态能力信息，不触发模型加载。"""
        return self._caption_config()

    def capabilities_runtime_status(self, device: str = "cpu") -> dict[str, Any]:
        """返回运行态能力信息，不触发模型加载。"""
        configured = self._caption_config()
        return {
            "caption": {
                **configured["caption"],
                "loaded": self._caption_runtime_ready(),
            },
            "device": self._resolve_device(device),
        }

    def runtime_model_report(self, device: str = "cpu") -> dict[str, Any]:
        """
        运行时模型命中报告（只读，不强制触发大模型下载/加载）。

        返回：
        - models：各任务的 primary/fallback、缓存命中与 caption 云就绪情况
        """
        resolved_device = self._resolve_device(device)

        def _task(primary_id: Optional[str]) -> dict[str, Any]:
            fb = get_fallback_model_id(primary_id) if primary_id else None
            return {"primary_model_id": primary_id, "fallback_model_id": fb}

        def _effective(candidates: list[str], cache: dict) -> Optional[str]:
            for mid in candidates:
                if (mid, resolved_device) in cache:
                    return mid
            return None

        object_primary = resolve_model_id("object")
        embed_primary = resolve_model_id("image_embedding")
        object_candidates = [x for x in [object_primary, get_fallback_model_id(object_primary) if object_primary else None] if x]
        embed_candidates = [x for x in [embed_primary, get_fallback_model_id(embed_primary) if embed_primary else None] if x]

        object_eff = _effective(object_candidates, self._object_models)
        embed_eff = _effective(embed_candidates, self._embedding_models)
        scene_eff = _effective(embed_candidates, self._scene_models)
        quality_eff = _effective(embed_candidates, self._quality_models)
        caption_ready = self._caption_runtime_ready()

        return {
            "device": resolved_device,
            "models": {
                "object": {
                    **_task(object_primary),
                    "effective_model_id": object_eff,
                    "loaded": object_eff is not None,
                },
                "image_embedding": {
                    **_task(embed_primary),
                    "effective_model_id": embed_eff,
                    "loaded": embed_eff is not None,
                },
                "scene": {
                    "effective_model_id": scene_eff,
                    "loaded": scene_eff is not None,
                },
                "quality": {
                    "effective_model_id": quality_eff,
                    "loaded": quality_eff is not None,
                },
                "caption": {
                    "primary_model_id": None,
                    "fallback_model_id": None,
                    "effective_model_id": "cloud" if caption_ready else None,
                    "loaded": caption_ready,
                    "cache_hit": False,
                    "mode": "cloud",
                },
            },
        }


# 全局单例，由 app 在 startup 时创建
_model_manager: Optional[ModelManager] = None


def get_model_manager() -> ModelManager:
    """获取全局 ModelManager，若未初始化则创建。"""
    global _model_manager
    if _model_manager is None:
        _model_manager = ModelManager()
    return _model_manager


def set_model_manager(manager: ModelManager) -> None:
    """供 app 注入 ModelManager（如测试或自定义配置）。"""
    global _model_manager
    _model_manager = manager
