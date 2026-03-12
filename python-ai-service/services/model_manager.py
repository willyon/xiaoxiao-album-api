#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ModelManager：按 capability + profile + resolved_device 管理模型实例
- 懒加载、并发锁、缓存复用（首版缓存 key 简化为 capability + profile + device）
- 各 get_* 方法：basic 且能力关闭时返回 None；未实现的能力返回 None，由 pipeline 返回空结构
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Optional

from config import settings
from logger import logger
from models.embedding_model import BgeM3TextEmbeddingModel, EmbeddingBundle, SiglipImageEmbeddingModel
from services.model_registry import (
    get_fallback_model_id,
    get_model_config,
    resolve_local_path,
    resolve_model_id,
)
from utils.device import resolve_device


class ModelManager:
    """
    统一模型管理：按能力提供 get_*_model(profile, device)。
    首版：已有能力（face/cleanup/ocr）委托现有 loader；caption/object/scene 占位返回 None。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # LRU 缓存：key -> model instance（超过 MODEL_CACHE_LIMIT 会逐出最久未使用项）
        self._caption_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._object_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._scene_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._ocr_engines: "OrderedDict[tuple, Any]" = OrderedDict()
        self._face_models: "OrderedDict[tuple, Any]" = OrderedDict()
        self._cleanup_models: "OrderedDict[tuple, Any]" = OrderedDict()
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

    def _basic_disabled(self) -> set[str]:
        raw = getattr(settings, "BASIC_DISABLED_CAPABILITIES", "") or ""
        return {x.strip().lower() for x in raw.split(",") if x.strip()}

    def _capability_enabled(self, profile: str, capability: str) -> bool:
        # basic 档按矩阵裁剪
        if (profile or "standard").lower() == "basic":
            return capability.lower() not in self._basic_disabled()
        return True

    def _resolve_device(self, device: str) -> str:
        return resolve_device(device or settings.DEFAULT_DEVICE)

    def _profile_ok(self, profile: str) -> bool:
        return profile in settings.SUPPORTED_PROFILES if profile else True

    def get_caption_model(self, profile: str, device: str) -> Optional[Any]:
        """
        Caption 模型；能力关闭时返回 None。

        规则：
        - 按 (profile, task_type='caption') 通过模型注册表解析首选 model_id；
        - 若该模型加载失败且存在 fallback_model_id，则自动回退；
        - 所有实例按 (model_id, resolved_device) 维度缓存。
        """
        if not getattr(settings, "ENABLE_CAPTION", False):
            return None
        if not self._capability_enabled(profile, "caption"):
            return None
        with self._lock:
            resolved_profile = profile or "standard"
            resolved_device = self._resolve_device(device)

            primary_id = resolve_model_id(resolved_profile, "caption")
            if not primary_id:
                logger.warning("get_caption_model: 未找到 profile=%s 的 caption 模型配置", resolved_profile)
                return None

            candidate_ids = [primary_id]
            fb = get_fallback_model_id(primary_id)
            if fb and fb not in candidate_ids:
                candidate_ids.append(fb)

            from models.caption_model import QwenCaptionModel

            last_error: Optional[Exception] = None
            for model_id in candidate_ids:
                cache_key = (model_id, resolved_device)
                if cache_key in self._caption_models:
                    self._touch(self._caption_models, cache_key)
                    return self._caption_models[cache_key]

                cfg = get_model_config(model_id)
                if not cfg:
                    continue
                try:
                    model = QwenCaptionModel(model_id=cfg.local_path)
                    self._put(self._caption_models, cache_key, model)
                    logger.info(
                        "get_caption_model: 已加载 caption 模型",
                        extra={"model_id": model_id, "profile": resolved_profile, "path": cfg.local_path},
                    )
                    return model
                except Exception as e:  # pragma: no cover
                    last_error = e
                    logger.warning(
                        "get_caption_model: 加载模型失败，将尝试 fallback（若有）",
                        extra={"model_id": model_id, "profile": resolved_profile, "error": str(e)},
                    )

            if last_error:
                logger.warning("get_caption_model: 所有候选 caption 模型加载失败: %s", last_error)
            return None

    def get_object_model(self, profile: str, device: str) -> Optional[Any]:
        """
        物体检测模型；能力关闭时返回 None。

        首版实现：
        - 基于模型注册表按 profile 解析 object 模型的 model_id
        - 优先使用当前 profile 对应模型（如 standard: yolo11m.onnx，enhanced: yolo26l.onnx）
        - 若 enhanced 模型加载失败，则回退到其 fallback（通常是 standard）
        - 同一 (model_id, device) 只加载一次并缓存
        """
        if not getattr(settings, "ENABLE_OBJECT_DETECTION", False):
            return None
        if not self._capability_enabled(profile, "object"):
            return None
        with self._lock:
            resolved_profile = profile or "standard"
            resolved_device = self._resolve_device(device)

            primary_id = resolve_model_id(resolved_profile, "object")
            if not primary_id:
                logger.warning("get_object_model: 未找到 profile=%s 的 object 模型配置", resolved_profile)
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
                        extra={"model_id": model_id, "profile": resolved_profile, "path": cfg.local_path},
                    )
                    return detector
                except Exception as e:  # pragma: no cover
                    last_error = e
                    logger.warning(
                        "get_object_model: 加载模型失败，将尝试 fallback（若有）",
                        extra={"model_id": model_id, "profile": resolved_profile, "error": str(e)},
                    )

            if last_error:
                logger.warning("get_object_model: 所有候选 object 模型加载失败: %s", last_error)
            return None

    def get_scene_model(self, profile: str, device: str) -> Optional[Any]:
        """场景分类模型；能力关闭时返回 None；启用时懒加载并缓存 SiglipSceneClassifier。"""
        if not getattr(settings, "ENABLE_SCENE_ANALYSIS", False):
            return None
        if not self._capability_enabled(profile, "scene"):
            return None
        with self._lock:
            resolved_profile = profile or "standard"
            # scene 依赖 image_embedding 的 SigLIP2，缓存 key 与注册表模型选择保持一致
            emb_id = resolve_model_id(resolved_profile, "image_embedding") or resolved_profile
            key = (emb_id, self._resolve_device(device))
            if key in self._scene_models:
                self._touch(self._scene_models, key)
                return self._scene_models.get(key)
            if key not in self._scene_models:
                try:
                    from models.scene_model import SiglipSceneClassifier
                    topk = getattr(settings, "SCENE_TOPK", 5)
                    self._put(self._scene_models, key, SiglipSceneClassifier(topk=topk, profile=resolved_profile))
                except Exception as e:
                    logger.warning("get_scene_model: 初始化失败 %s", e)
                    return None
            return self._scene_models.get(key)

    def get_ocr_engine(self, profile: str, device: str) -> Optional[Any]:
        """OCR 引擎；能力关闭时返回 None；返回 PaddleOcrEngine 包装（含 resize + bbox 回原图）。"""
        if not settings.ENABLE_OCR:
            return None
        if not self._capability_enabled(profile, "ocr"):
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key in self._ocr_engines:
                self._touch(self._ocr_engines, key)
                return self._ocr_engines.get(key)
            if key not in self._ocr_engines:
                try:
                    from loaders.ocr_loader import get_ocr_model
                    from models.ocr_engine import PaddleOcrEngine
                    self._put(self._ocr_engines, key, PaddleOcrEngine(get_ocr_model()))
                except Exception as e:
                    logger.warning("get_ocr_engine: 加载失败 %s", e)
                    return None
            return self._ocr_engines.get(key)

    def get_face_model(self, profile: str, device: str) -> Optional[Any]:
        """人物分析模型（人脸 + 人体）；由 PersonAnalyzer 封装。"""
        if not self._capability_enabled(profile, "face"):
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key in self._face_models:
                self._touch(self._face_models, key)
                return self._face_models.get(key)
            if key not in self._face_models:
                try:
                    from models.person_model import PersonAnalyzer

                    self._put(self._face_models, key, PersonAnalyzer())
                except Exception as e:
                    logger.warning("get_face_model: 初始化失败 %s", e)
                    return None
            return self._face_models.get(key)

    def get_cleanup_model(self, profile: str, device: str) -> Optional[Any]:
        """清理/审美模型（SigLIP + Aesthetic Head）；由 CleanupAnalyzer 封装。"""
        if not self._capability_enabled(profile, "cleanup"):
            return None
        with self._lock:
            resolved_profile = profile or "standard"
            emb_id = resolve_model_id(resolved_profile, "image_embedding") or resolved_profile
            key = (emb_id, self._resolve_device(device))
            if key in self._cleanup_models:
                self._touch(self._cleanup_models, key)
                return self._cleanup_models.get(key)
            if key not in self._cleanup_models:
                try:
                    from models.cleanup_model import CleanupAnalyzer

                    self._put(self._cleanup_models, key, CleanupAnalyzer())
                except Exception as e:
                    logger.warning("get_cleanup_model: 初始化失败 %s", e)
                    return None
            return self._cleanup_models.get(key)

    def get_embedding_model(self, profile: str, device: str) -> Optional[Any]:
        """
        Image/Text embedding 模型聚合：
        - image_model: SigLIP2 图像向量（与现有 1152 维向量兼容）
        - text_model: BGE-M3 文本向量（骨架，暂未接入现有索引主链路）
        """
        if not getattr(settings, "ENABLE_EMBEDDING", False):
            return None
        if not self._capability_enabled(profile, "embedding"):
            return None
        with self._lock:
            resolved_profile = profile or "standard"
            resolved_device = self._resolve_device(device)
            emb_id = resolve_model_id(resolved_profile, "image_embedding") or resolved_profile
            key = (emb_id, resolved_device)
            if key in self._embedding_models:
                self._touch(self._embedding_models, key)
                return self._embedding_models.get(key)
            if key not in self._embedding_models:
                try:
                    image_model = SiglipImageEmbeddingModel(profile=resolved_profile)
                    # BGE-M3 作为可选能力，加载失败时仍可使用 image_model
                    text_model: Optional[BgeM3TextEmbeddingModel]
                    try:
                        text_model = BgeM3TextEmbeddingModel()
                    except Exception as inner_exc:  # pragma: no cover
                        logger.warning("初始化 BGE-M3 文本模型失败，将仅提供图像向量: %s", inner_exc)
                        text_model = None
                    self._put(self._embedding_models, key, EmbeddingBundle(image_model=image_model, text_model=text_model))
                except Exception as e:
                    logger.warning("get_embedding_model: 初始化失败 %s", e)
                    return None
            return self._embedding_models.get(key)

    def capabilities_loaded_for_profile(self, profile: str) -> dict[str, bool]:
        """按指定 profile 计算能力是否可用（供 /health 展示 profile 可用性与降级）。"""
        resolved_profile = profile or "standard"
        face = self.get_face_model(resolved_profile, "cpu") is not None
        cleanup = self.get_cleanup_model(resolved_profile, "cpu") is not None
        ocr = self.get_ocr_engine(resolved_profile, "cpu") is not None
        # caption 对 enhanced 可能触发 VLM 加载，避免在健康检查里强制加载
        caption = getattr(settings, "ENABLE_CAPTION", False)
        object_ = self.get_object_model(resolved_profile, "cpu") is not None
        scene = self.get_scene_model(resolved_profile, "cpu") is not None
        embedding = self.get_embedding_model(resolved_profile, "cpu") is not None
        return {
            "caption": bool(caption),
            "object": object_,
            "scene": scene,
            "ocr": ocr,
            "face": face,
            "cleanup": cleanup,
            "embedding": embedding,
        }

    def capabilities_loaded(self) -> dict[str, bool]:
        """各能力是否已有可用模型（供 /health）。"""
        face = self.get_face_model("standard", "cpu") is not None
        cleanup = self.get_cleanup_model("standard", "cpu") is not None
        ocr = self.get_ocr_engine("standard", "cpu") is not None
        # caption 可能触发大模型下载/加载，不在健康检查中强制初始化
        caption = bool(getattr(settings, "ENABLE_CAPTION", False))
        object_ = self.get_object_model("standard", "cpu") is not None
        scene = self.get_scene_model("standard", "cpu") is not None
        embedding = self.get_embedding_model("standard", "cpu") is not None
        return {
            "caption": caption,
            "object": object_,
            "scene": scene,
            "ocr": ocr,
            "face": face,
            "cleanup": cleanup,
            "embedding": embedding,
        }

    def runtime_model_report(self, device: str = "cpu") -> dict[str, Any]:
        """
        运行时模型命中报告（只读，不强制触发大模型下载/加载）。

        返回：
        - profiles: 每个 profile 下，各任务的 primary/fallback、当前缓存是否已加载、以及“实际命中”模型（若已加载）
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

        out: dict[str, Any] = {"device": resolved_device, "profiles": {}}
        for p in settings.SUPPORTED_PROFILES:
            prof = p
            object_primary = resolve_model_id(prof, "object")
            embed_primary = resolve_model_id(prof, "image_embedding")
            caption_primary = resolve_model_id(prof, "caption")

            object_candidates = [x for x in [object_primary, get_fallback_model_id(object_primary) if object_primary else None] if x]
            embed_candidates = [x for x in [embed_primary, get_fallback_model_id(embed_primary) if embed_primary else None] if x]
            caption_candidates = [x for x in [caption_primary, get_fallback_model_id(caption_primary) if caption_primary else None] if x]

            object_eff = _effective(object_candidates, self._object_models)
            embed_eff = _effective(embed_candidates, self._embedding_models)
            scene_eff = _effective(embed_candidates, self._scene_models)  # scene 与 embedding 同源
            cleanup_eff = _effective(embed_candidates, self._cleanup_models)  # cleanup 与 embedding 同源
            # caption 不强制加载：仅看缓存命中（若之前请求过）
            caption_eff = _effective(caption_candidates, self._caption_models)

            out["profiles"][prof] = {
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
                "cleanup": {
                    "effective_model_id": cleanup_eff,
                    "loaded": cleanup_eff is not None,
                },
                "caption": {
                    **_task(caption_primary),
                    "effective_model_id": caption_eff,
                    "loaded": caption_eff is not None,
                    "enabled": bool(getattr(settings, "ENABLE_CAPTION", False)),
                },
            }
        return out


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
