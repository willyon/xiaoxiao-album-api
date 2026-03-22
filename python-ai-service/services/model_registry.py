#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模型注册表（model_registry）
---------------------------
- 统一维护各任务的模型信息：model_id / task_type / registry_scope / local_path / runtime / load_strategy / fallback 等
- 只读配置层；ModelManager 与 loaders 按 task_type 解析主模型
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
    registry_scope: str  # primary：任务主模型；shared：多任务共用权重
    local_path: str     # 相对 python-ai-service 根目录的路径
    runtime: str        # onnxruntime | insightface | other
    device_support: str  # cpu|mps|cuda|mixed
    load_strategy: str   # lazy_load | temporary（启动不预加载，均为按需加载）
    is_primary: bool = True
    fallback_model_id: Optional[str] = None
    version: Optional[str] = None
    notes: Optional[str] = None
    # 扩展：用于标记第三方自管权重等元数据（external_managed/local_managed 等）
    source_type: str = "local_managed"   # local_managed | external_managed
    provider: Optional[str] = None       # 例如 insightface / emotiefflib
    is_optional: bool = False            # true 表示失败不阻塞主链路


# 核心模型注册信息
# 说明：local_path 默认按《Python-AI服务完整修改方案》和《准备手册》约定；
# 后续如需项目级可配置路径，可在 config 中增加 MODELS_BASE_DIR 拼接。
MODEL_CONFIGS: Dict[str, ModelConfig] = {
    # 人脸主干（InsightFace，缓存重定向到项目内 models/cache/insightface）
    "face.shared.insightface.buffalo_l": ModelConfig(
        model_id="face.shared.insightface.buffalo_l",
        task_type="face",
        registry_scope="shared",
        local_path="models/cache/insightface",
        runtime="insightface",
        device_support="mixed",
        load_strategy="lazy_load",
        is_primary=True,
        notes="人脸检测 + 特征提取",
        source_type="external_managed",
        provider="insightface",
        is_optional=False,
    ),
    # 人脸属性（FairFace，可选，仅 age/gender）
    "face.shared.fairface.age_gender": ModelConfig(
        model_id="face.shared.fairface.age_gender",
        task_type="face_attribute",
        registry_scope="shared",
        local_path="models/managed/face/fairface.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="年龄/性别属性，可选，lazy；失败不影响主链路",
        source_type="local_managed",
        provider="onnxruntime",
        is_optional=True,
    ),
    # 物体检测（YOLOv11x ONNX，权重位于 models/managed/object/）
    "object.standard.yolo.11x": ModelConfig(
        model_id="object.standard.yolo.11x",
        task_type="object",
        registry_scope="primary",
        local_path="models/managed/object/yolo11x.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        fallback_model_id=None,
        notes="物体检测YOLOv11x；更在意速度可改用 YOLO11m",
    ),
    # 跨模态 embedding（SigLIP2 so400m 384，输出 1152 维，与 aesthetic_head 一致）
    "embedding.standard.siglip2.base": ModelConfig(
        model_id="embedding.standard.siglip2.base",
        task_type="image_embedding",
        registry_scope="primary",
        local_path="models/managed/siglip2",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="SigLIP2（so400m 384，1152 维），与 aesthetic_head 一致",
    ),
    # 质量/美学评分头（原 cleanup 能力）；两 key 同源，便于 health/前端用 quality 命名
    "quality.shared.aesthetic_head.musiq": ModelConfig(
        model_id="quality.shared.aesthetic_head.musiq",
        task_type="quality",
        registry_scope="shared",
        local_path="models/managed/aesthetic_head_musiq/siglip_aesthetic_head.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="SigLIP embedding → 审美分的 ONNX 小头",
        source_type="local_managed",
        provider="onnxruntime",
        is_optional=False,
    ),
    "cleanup.shared.aesthetic_head.musiq": ModelConfig(
        model_id="quality.shared.aesthetic_head.musiq",
        task_type="quality",
        registry_scope="shared",
        local_path="models/managed/aesthetic_head_musiq/siglip_aesthetic_head.onnx",
        runtime="onnxruntime",
        device_support="cpu",
        load_strategy="lazy_load",
        is_primary=True,
        notes="SigLIP embedding → 审美分的 ONNX 小头（兼容旧 key）",
        source_type="local_managed",
        provider="onnxruntime",
        is_optional=False,
    ),
    # 表情识别（EmotiEffLib，自管权重，可选）
    "face.shared.emotiefflib.default": ModelConfig(
        model_id="face.shared.emotiefflib.default",
        task_type="expression",
        registry_scope="shared",
        local_path="external://emotiefflib/enet_b0_8_best_afew",
        runtime="other",
        device_support="cpu",
        load_strategy="lazy_load",
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
    - ~ 开头、以及包含 scheme（如 http://）的路径原样返回
    - 绝对路径原样返回
    - 相对路径：优先使用 settings.MODELS_BASE_DIR 拼接
      - 若 local_path 以 "models/" 开头，则去掉前缀后再与 MODELS_BASE_DIR 拼接
      - 否则直接与 MODELS_BASE_DIR 拼接
    """
    if not local_path:
        return local_path
    if local_path.startswith("~"):
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
        if not p or "://" in p or p.startswith("~"):
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
        "registry_scope": "primary",
        "local_path": "models/managed/object/yolo11x.onnx",
        "runtime": "onnxruntime",
        "device_support": "cpu",
        "load_strategy": "lazy_load",
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
                    registry_scope=str(raw.get("registry_scope", "shared")),
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


def resolve_model_id(task_type: str) -> Optional[str]:
    """
    按 task_type 解析首选 model_id。

    规则：
    - 先匹配 registry_scope == primary 的主模型
    - 若无，再匹配 registry_scope == shared
    """
    tt = (task_type or "").strip().lower()
    if not tt:
        return None
    for cfg in MODEL_CONFIGS.values():
        if cfg.task_type == tt and cfg.registry_scope == "primary" and cfg.is_primary:
            return cfg.model_id
    for cfg in MODEL_CONFIGS.values():
        if cfg.task_type == tt and cfg.registry_scope == "shared" and cfg.is_primary:
            return cfg.model_id
    return None


def get_fallback_model_id(model_id: str) -> Optional[str]:
    """获取指定模型的 fallback model_id（若有）。"""
    cfg = get_model_config(model_id)
    if not cfg:
        return None
    return cfg.fallback_model_id
