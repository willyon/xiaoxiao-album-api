#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模型注册表（model_registry）
---------------------------
- 统一维护各任务的模型信息：model_id / task_type / profile_scope / local_path / runtime / load_strategy / fallback 等
- 目前仅作为只读配置层，不改变现有加载行为
- 后续由 ModelManager 与 loaders 基于此做 profile 路由与懒加载
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from typing import Dict, List, Optional

from config import settings


@dataclass(frozen=True)
class ModelConfig:
    model_id: str
    task_type: str
    profile_scope: str  # basic | standard | enhanced | shared
    local_path: str     # 相对 python-ai-service 根目录的路径
    runtime: str        # onnxruntime | insightface | paddleocr | transformers | other
    device_support: str  # cpu|mps|cuda|mixed
    load_strategy: str   # preload | lazy_load | temporary
    is_primary: bool = True
    fallback_model_id: Optional[str] = None
    version: Optional[str] = None
    notes: Optional[str] = None
    # 扩展：用于标记第三方自管权重等元数据（external_managed/local_managed 等）
    source_type: str = "local_managed"   # local_managed | external_managed
    provider: Optional[str] = None       # 例如 insightface / paddleocr / emotiefflib
    is_optional: bool = False            # true 表示失败不阻塞主链路


# 核心模型注册信息
# 说明：local_path 默认按《Python-AI服务完整修改方案》和《准备手册》约定；
# 后续如需项目级可配置路径，可在 config 中增加 MODELS_BASE_DIR 拼接。
MODEL_CONFIGS: Dict[str, ModelConfig] = {
    # 人脸主干（InsightFace，缓存重定向到项目内 models/cache/insightface）
    "face.shared.insightface.buffalo_l": ModelConfig(
        model_id="face.shared.insightface.buffalo_l",
        task_type="face",
        profile_scope="shared",
        local_path="models/cache/insightface",
        runtime="insightface",
        device_support="mixed",
        load_strategy="preload",
        is_primary=True,
        notes="人脸检测 + 特征提取，所有 profile 共用",
        source_type="external_managed",
        provider="insightface",
        is_optional=False,
    ),
    # 人脸属性（FairFace，可选）
    "face.standard.fairface.age_gender": ModelConfig(
        model_id="face.standard.fairface.age_gender",
        task_type="face_attribute",
        profile_scope="standard",
        local_path="models/managed/face/fairface.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="年龄/性别属性，可选分支，失败不影响主链路",
        source_type="local_managed",
        provider="onnxruntime",
        is_optional=True,
    ),
    # OCR 主干（PaddleOCR）
    "ocr.shared.paddleocr.ppocrv5": ModelConfig(
        model_id="ocr.shared.paddleocr.ppocrv5",
        task_type="ocr",
        profile_scope="shared",
        local_path="models/cache/paddleocr",
        runtime="paddleocr",
        device_support="cpu",
        load_strategy="preload",
        is_primary=True,
        notes="PaddleOCR PP-OCRv5，standard/enhanced 共用",
        source_type="external_managed",
        provider="paddleocr",
        is_optional=False,
    ),
    # 物体检测 standard（YOLOv11x ONNX）
    "object.standard.yolo.11x": ModelConfig(
        model_id="object.standard.yolo.11x",
        task_type="object",
        profile_scope="standard",
        local_path="models/managed/object/yolo11x.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="preload",
        is_primary=True,
        fallback_model_id=None,
        notes="物体检测 standard 档，基于导出的 YOLOv11x ONNX",
    ),
    # 物体检测 enhanced（仍使用 YOLOv11x ONNX，策略层做档位差异）
    "object.enhanced.yolo.11x": ModelConfig(
        model_id="object.enhanced.yolo.11x",
        task_type="object",
        profile_scope="enhanced",
        local_path="models/managed/object/yolo11x.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        fallback_model_id="object.standard.yolo.11x",
        notes="物体检测 enhanced 档，当前与 standard 共用 YOLOv11x ONNX，失败时回退到 standard",
    ),
    # 跨模态 embedding standard（SigLIP2 standard）
    "embedding.standard.siglip2.base": ModelConfig(
        model_id="embedding.standard.siglip2.base",
        task_type="image_embedding",
        profile_scope="standard",
        local_path="models/managed/siglip2/standard",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="preload",
        is_primary=True,
        notes="SigLIP2 standard 导出物（image/text encoder + metadata/tokenizer）",
    ),
    # 跨模态 embedding enhanced（SigLIP2 enhanced）
    "embedding.enhanced.siglip2.so400m": ModelConfig(
        model_id="embedding.enhanced.siglip2.so400m",
        task_type="image_embedding",
        profile_scope="enhanced",
        local_path="models/managed/siglip2/enhanced",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        fallback_model_id="embedding.standard.siglip2.base",
        notes="SigLIP2 enhanced 导出物，失败回退 standard",
    ),
    # 文本 embedding（BGE-M3）
    "text.shared.bge.m3": ModelConfig(
        model_id="text.shared.bge.m3",
        task_type="text_embedding",
        profile_scope="shared",
        local_path="huggingface://BAAI/bge-m3",
        runtime="transformers",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="BGE-M3 文本向量，仅作为文本语义能力",
    ),
    # Caption 增强模型（standard 按需）
    "caption.standard.qwen2_5_vl.3b_lazy": ModelConfig(
        model_id="caption.standard.qwen2_5_vl.3b_lazy",
        task_type="caption",
        profile_scope="standard",
        local_path="huggingface://Qwen/Qwen2.5-VL-3B-Instruct",
        runtime="transformers",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="standard 档按需使用 Qwen2.5-VL-3B 生成 caption",
    ),
    # Caption 增强模型（enhanced 核心）
    "caption.enhanced.qwen2_5_vl.3b": ModelConfig(
        model_id="caption.enhanced.qwen2_5_vl.3b",
        task_type="caption",
        profile_scope="enhanced",
        local_path="huggingface://Qwen/Qwen2.5-VL-3B-Instruct",
        runtime="transformers",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        fallback_model_id="caption.standard.qwen2_5_vl.3b_lazy",
        notes="enhanced 档以 Qwen2.5-VL-3B 为主，失败回退 standard 懒加载模型",
    ),
    # 清理美学评分头
    "cleanup.shared.aesthetic_head.musiq": ModelConfig(
        model_id="cleanup.shared.aesthetic_head.musiq",
        task_type="cleanup",
        profile_scope="shared",
        local_path="models/managed/aesthetic_head_musiq/siglip_aesthetic_head.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="preload",
        is_primary=True,
        notes="SigLIP embedding → 审美分的 ONNX 小头",
        source_type="local_managed",
        provider="onnxruntime",
        is_optional=False,
    ),
    # 表情识别（EmotiEffLib，自管权重，可选）
    "face.shared.emotiefflib.default": ModelConfig(
        model_id="face.shared.emotiefflib.default",
        task_type="expression",
        profile_scope="shared",
        local_path="external://emotiefflib/enet_b0_8_best_afew",
        runtime="other",
        device_support="cpu",
        load_strategy="preload",
        is_primary=True,
        notes="表情识别能力，由 EmotiEffLib 自行管理模型与缓存，可选能力",
        source_type="external_managed",
        provider="emotiefflib",
        is_optional=True,
    ),
}


def get_model_config(model_id: str) -> Optional[ModelConfig]:
    """根据 model_id 获取模型配置。找不到返回 None。"""
    return MODEL_CONFIGS.get(model_id)


def resolve_local_path(local_path: str) -> str:
    """
    将注册表中的 local_path 解析为可用于文件系统访问的路径。

    规则：
    - huggingface://...、~ 开头、以及包含 scheme（如 http://）的路径原样返回
    - 绝对路径原样返回
    - 相对路径：优先使用 settings.MODELS_BASE_DIR 拼接
      - 若 local_path 以 "models/" 开头，则去掉前缀后再与 MODELS_BASE_DIR 拼接
      - 否则直接与 MODELS_BASE_DIR 拼接
    """
    if not local_path:
        return local_path
    if local_path.startswith("huggingface://") or local_path.startswith("~"):
        return local_path
    if "://" in local_path:
        return local_path
    if os.path.isabs(local_path):
        return local_path

    base = getattr(settings, "MODELS_BASE_DIR", "models") or "models"
    rel = local_path
    if rel.startswith("models/"):
        rel = rel[len("models/") :]
    return os.path.normpath(os.path.join(base, rel))


def get_model_fs_path(model_id: str) -> Optional[str]:
    """获取指定 model_id 的文件系统路径（已按 MODELS_BASE_DIR 解析）。"""
    cfg = get_model_config(model_id)
    if not cfg:
        return None
    return resolve_local_path(cfg.local_path)


def get_model_version(model_id: str) -> Optional[str]:
    """
    尝试读取模型版本（若存在）。
    - 若注册表中 cfg.version 已配置，优先返回
    - 若 local_path 指向目录且含 version.txt，读取其内容
    """
    cfg = get_model_config(model_id)
    if not cfg:
        return None
    if cfg.version:
        return str(cfg.version)
    try:
        p = resolve_local_path(cfg.local_path)
        if not p or p.startswith("huggingface://") or "://" in p or p.startswith("~"):
            return None
        fs = os.path.expanduser(p)
        if os.path.isdir(fs):
            ver_path = os.path.join(fs, "version.txt")
            if os.path.exists(ver_path):
                with open(ver_path, "r", encoding="utf-8") as f:
                    v = (f.read() or "").strip()
                return v or None
        return None
    except Exception:
        return None


def _apply_external_registry_overrides() -> None:
    """
    可选：从外部 JSON 文件加载/覆盖注册表（阶段 4：配置外置）。

    文件格式（示例）：
    {
      "object.standard.yolo.11x": {
        "task_type": "object",
        "profile_scope": "standard",
        "local_path": "models/managed/object/yolo11x.onnx",
        "runtime": "onnxruntime",
        "device_support": "cpu",
        "load_strategy": "preload",
        "fallback_model_id": null,
        "notes": "..."
      }
    }
    """
    path = getattr(settings, "MODEL_REGISTRY_PATH", "") or ""
    if not path:
        return
    try:
        fs_path = os.path.expanduser(path)
        if not os.path.exists(fs_path):
            return
        with open(fs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        for model_id, raw in data.items():
            if not isinstance(model_id, str) or not isinstance(raw, dict):
                continue
            try:
                MODEL_CONFIGS[model_id] = ModelConfig(
                    model_id=model_id,
                    task_type=str(raw.get("task_type", "")),
                    profile_scope=str(raw.get("profile_scope", "shared")),
                    local_path=str(raw.get("local_path", "")),
                    runtime=str(raw.get("runtime", "other")),
                    device_support=str(raw.get("device_support", "cpu")),
                    load_strategy=str(raw.get("load_strategy", "lazy_load")),
                    is_primary=bool(raw.get("is_primary", True)),
                    fallback_model_id=raw.get("fallback_model_id"),
                    version=raw.get("version"),
                    notes=raw.get("notes"),
                )
            except Exception:
                continue
    except Exception:
        # 外置配置失败不应阻断服务启动
        return


# 模块加载时应用外部覆盖（若配置了 MODEL_REGISTRY_PATH）
_apply_external_registry_overrides()


def list_models_by_task(task_type: str) -> List[ModelConfig]:
    """按任务类型列出所有模型配置。"""
    return [cfg for cfg in MODEL_CONFIGS.values() if cfg.task_type == task_type]


def resolve_model_id(profile: str, task_type: str) -> Optional[str]:
    """
    根据 profile 与 task_type 解析首选 model_id。

    规则（首版简单实现）：
    - 先优先匹配 profile_scope == profile 的主模型
    - 若找不到，退化到 profile_scope == 'shared'
    """
    profile = (profile or "standard").lower()
    # 1) 精确 profile 匹配
    for cfg in MODEL_CONFIGS.values():
        if cfg.task_type == task_type and cfg.profile_scope == profile and cfg.is_primary:
            return cfg.model_id
    # 2) 退化 shared
    for cfg in MODEL_CONFIGS.values():
        if cfg.task_type == task_type and cfg.profile_scope == "shared" and cfg.is_primary:
            return cfg.model_id
    return None


def get_fallback_model_id(model_id: str) -> Optional[str]:
    """获取指定模型的 fallback model_id（若有）。"""
    cfg = MODEL_CONFIGS.get(model_id)
    if not cfg:
        return None
    return cfg.fallback_model_id

