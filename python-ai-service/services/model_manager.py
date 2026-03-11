#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ModelManager：按 capability + profile + resolved_device 管理模型实例
- 懒加载、并发锁、缓存复用（首版缓存 key 简化为 capability + profile + device）
- 各 get_* 方法：basic 且能力关闭时返回 None；未实现的能力返回 None，由 pipeline 返回空结构
"""

from __future__ import annotations

import threading
from typing import Any, Optional

from config import settings
from logger import logger
from models.embedding_model import BgeM3TextEmbeddingModel, EmbeddingBundle, SiglipImageEmbeddingModel
from utils.device import resolve_device


class ModelManager:
    """
    统一模型管理：按能力提供 get_*_model(profile, device)。
    首版：已有能力（face/cleanup/ocr）委托现有 loader；caption/object/scene 占位返回 None。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # 后续可按 (capability, profile, device) 做缓存，首版仅委托
        self._caption_models: dict = {}
        self._object_models: dict = {}
        self._scene_models: dict = {}
        self._ocr_engines: dict = {}
        self._face_models: dict = {}
        self._cleanup_models: dict = {}
        self._embedding_models: dict = {}

    def _resolve_device(self, device: str) -> str:
        return resolve_device(device or settings.DEFAULT_DEVICE)

    def _profile_ok(self, profile: str) -> bool:
        return profile in settings.SUPPORTED_PROFILES if profile else True

    def get_caption_model(self, profile: str, device: str) -> Optional[Any]:
        """Caption 模型；能力关闭时返回 None；启用时懒加载并缓存 QwenCaptionModel。"""
        if not getattr(settings, "ENABLE_CAPTION", False):
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._caption_models:
                try:
                    from models.caption_model import QwenCaptionModel

                    self._caption_models[key] = QwenCaptionModel()
                except Exception as e:
                    logger.warning("get_caption_model: 初始化失败 %s", e)
                    return None
            return self._caption_models.get(key)

    def get_object_model(self, profile: str, device: str) -> Optional[Any]:
        """物体检测模型；能力关闭时返回 None；启用时懒加载并缓存 YoloObjectDetector。"""
        if not getattr(settings, "ENABLE_OBJECT_DETECTION", False):
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._object_models:
                try:
                    from models.object_model import YoloObjectDetector

                    self._object_models[key] = YoloObjectDetector()
                except Exception as e:
                    logger.warning("get_object_model: 初始化失败 %s", e)
                    return None
            return self._object_models.get(key)

    def get_scene_model(self, profile: str, device: str) -> Optional[Any]:
        """场景分类模型；能力关闭时返回 None；启用时懒加载并缓存 SiglipSceneClassifier。"""
        if not getattr(settings, "ENABLE_SCENE_ANALYSIS", False):
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._scene_models:
                try:
                    from models.scene_model import SiglipSceneClassifier
                    topk = getattr(settings, "SCENE_TOPK", 5)
                    self._scene_models[key] = SiglipSceneClassifier(topk=topk)
                except Exception as e:
                    logger.warning("get_scene_model: 初始化失败 %s", e)
                    return None
            return self._scene_models.get(key)

    def get_ocr_engine(self, profile: str, device: str) -> Optional[Any]:
        """OCR 引擎；能力关闭时返回 None；返回 PaddleOcrEngine 包装（含 resize + bbox 回原图）。"""
        if not settings.ENABLE_OCR:
            return None
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._ocr_engines:
                try:
                    from loaders.ocr_loader import get_ocr_model
                    from models.ocr_engine import PaddleOcrEngine
                    self._ocr_engines[key] = PaddleOcrEngine(get_ocr_model())
                except Exception as e:
                    logger.warning("get_ocr_engine: 加载失败 %s", e)
                    return None
            return self._ocr_engines.get(key)

    def get_face_model(self, profile: str, device: str) -> Optional[Any]:
        """人物分析模型（人脸 + 人体）；由 PersonAnalyzer 封装。"""
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._face_models:
                try:
                    from models.person_model import PersonAnalyzer

                    self._face_models[key] = PersonAnalyzer()
                except Exception as e:
                    logger.warning("get_face_model: 初始化失败 %s", e)
                    return None
            return self._face_models.get(key)

    def get_cleanup_model(self, profile: str, device: str) -> Optional[Any]:
        """清理/审美模型（SigLIP + Aesthetic Head）；由 CleanupAnalyzer 封装。"""
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._cleanup_models:
                try:
                    from models.cleanup_model import CleanupAnalyzer

                    self._cleanup_models[key] = CleanupAnalyzer()
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
        with self._lock:
            key = (profile or "standard", self._resolve_device(device))
            if key not in self._embedding_models:
                try:
                    image_model = SiglipImageEmbeddingModel()
                    # BGE-M3 作为可选能力，加载失败时仍可使用 image_model
                    text_model: Optional[BgeM3TextEmbeddingModel]
                    try:
                        text_model = BgeM3TextEmbeddingModel()
                    except Exception as inner_exc:  # pragma: no cover
                        logger.warning("初始化 BGE-M3 文本模型失败，将仅提供图像向量: %s", inner_exc)
                        text_model = None
                    self._embedding_models[key] = EmbeddingBundle(image_model=image_model, text_model=text_model)
                except Exception as e:
                    logger.warning("get_embedding_model: 初始化失败 %s", e)
                    return None
            return self._embedding_models.get(key)

    def capabilities_loaded(self) -> dict[str, bool]:
        """各能力是否已有可用模型（供 /health）。"""
        face = self.get_face_model("standard", "cpu") is not None
        cleanup = self.get_cleanup_model("standard", "cpu") is not None
        ocr = self.get_ocr_engine("standard", "cpu") is not None
        caption = self.get_caption_model("standard", "cpu") is not None
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
