#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_image 编排器（POST /analyze_image）：串行执行各模块，聚合为统一返回结构。
返回：image_id、总耗时 duration_ms、data 下四键 embedding / person / quality / caption。
每模块：status、duration_ms；成功时 data 为缺省键；失败时 error，无 data。
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from constants.error_codes import AI_SERVICE_ERROR, IMAGE_DECODE_FAILED, MODULE_DISABLED
from config import normalize_provider, settings
from logger import logger
from providers import get_caption_provider
from services.module_result import MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result

# 智能分析全流程固定顺序：caption（VLM 描述/标签）为主语义，其他模块为辅助
IMAGE_ANALYSIS_MODULE_ORDER = [
    "embedding",
    "person",
    "quality",
    "caption",
]


def _coerce_non_negative_int(value: Any) -> int:
    """caption 的 face_count / person_count：缺省或非法时视为 0。"""
    if value is None:
        return 0
    try:
        n = int(round(float(value)))
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _sparse_caption_data(raw: Dict[str, Any]) -> Dict[str, Any]:
    """成功时仅保留有落库意义的键；face_count / person_count 始终写出（含 0）。"""
    out: Dict[str, Any] = {}
    desc = str(raw.get("description") or "").strip()
    if desc:
        out["description"] = desc
    for key in ("keywords", "subject_tags", "action_tags", "scene_tags"):
        arr = raw.get(key)
        if isinstance(arr, list) and len(arr) > 0:
            out[key] = list(arr)
    ocr = str(raw.get("ocr") or "").strip()
    if ocr:
        out["ocr"] = ocr
    out["face_count"] = _coerce_non_negative_int(raw.get("face_count"))
    out["person_count"] = _coerce_non_negative_int(raw.get("person_count"))
    return out


def _sparse_person_data(raw: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["face_count"] = _coerce_non_negative_int(raw.get("face_count"))
    out["person_count"] = _coerce_non_negative_int(raw.get("person_count"))
    faces = raw.get("faces")
    if isinstance(faces, list) and len(faces) > 0:
        out["faces"] = faces
    summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
    expr = summary.get("expressions") or []
    ages = summary.get("ages") or []
    genders = summary.get("genders") or []
    sub: Dict[str, Any] = {}
    if expr:
        sub["expressions"] = expr
    if ages:
        sub["ages"] = ages
    if genders:
        sub["genders"] = genders
    if sub:
        out["summary"] = sub
    return out


def _sparse_quality_data(raw: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    hashes = raw.get("hashes") if isinstance(raw.get("hashes"), dict) else {}
    h: Dict[str, Any] = {}
    if hashes.get("phash"):
        h["phash"] = hashes["phash"]
    if hashes.get("dhash"):
        h["dhash"] = hashes["dhash"]
    if h:
        out["hashes"] = h
    aes = raw.get("aesthetic_score")
    sharp = raw.get("sharpness_score")
    if isinstance(aes, (int, float)) and aes == aes:
        out["aesthetic_score"] = float(aes)
    if isinstance(sharp, (int, float)) and sharp == sharp:
        out["sharpness_score"] = float(sharp)
    return out


def _finalize_module_data(name: str, module_result: Dict[str, Any]) -> Dict[str, Any]:
    """成功路径：将 data 转为缺省键；失败路径：去掉可能残留的 data。"""
    if module_result.get("status") != MODULE_STATUS_SUCCESS:
        return {k: v for k, v in module_result.items() if k != "data"}
    data = module_result.get("data")
    if not isinstance(data, dict):
        out = dict(module_result)
        out.pop("data", None)
        return out
    sparse: Dict[str, Any]
    if name == "caption":
        sparse = _sparse_caption_data(data)
    elif name == "person":
        sparse = _sparse_person_data(data)
    elif name == "quality":
        sparse = _sparse_quality_data(data)
    else:
        sparse = data
    out = dict(module_result)
    if sparse:
        out["data"] = sparse
    else:
        out.pop("data", None)
    return out


def _bgr_to_rgb_safe(image_bgr: np.ndarray) -> np.ndarray:
    """BGR / 灰度 / BGRA → RGB，避免非三通道时 cv2.cvtColor 抛错导致整请求 500。"""
    if image_bgr.ndim == 2:
        return cv2.cvtColor(image_bgr, cv2.COLOR_GRAY2RGB)
    if image_bgr.ndim != 3:
        raise ValueError("unsupported image shape for RGB conversion")
    ch = image_bgr.shape[2]
    if ch == 1:
        return cv2.cvtColor(image_bgr[:, :, 0], cv2.COLOR_GRAY2RGB)
    if ch == 3:
        return cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    if ch == 4:
        bgr = cv2.cvtColor(image_bgr, cv2.COLOR_BGRA2BGR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    raise ValueError(f"unsupported channel count: {ch}")


def run_analyze_image(
    image_bgr: np.ndarray,
    device: str,
    manager: Any,
    image_id: Optional[str] = None,
    module_names: Optional[List[str]] = None,
    cloud_api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    串行执行各分析模块，聚合为统一结构。
    返回含 image_id、duration_ms、data（四模块）。
    """
    if image_bgr is None or not isinstance(image_bgr, np.ndarray):
        return _fail_response(
            image_id=image_id,
            errors=[{"code": IMAGE_DECODE_FAILED, "message": "无效的图片数据"}],
        )
    selected_modules = module_names or IMAGE_ANALYSIS_MODULE_ORDER
    try:
        rgb_image = _bgr_to_rgb_safe(image_bgr)
    except Exception as exc:
        return _fail_response(
            image_id=image_id,
            errors=[{"code": IMAGE_DECODE_FAILED, "message": str(exc)}],
        )

    started_at = time.perf_counter()
    modules: Dict[str, Dict[str, Any]] = {}

    for name in selected_modules:
        t0 = time.perf_counter()
        try:
            module_result = _run_one_module(
                name,
                image_bgr=image_bgr,
                rgb_image=rgb_image,
                device=device,
                manager=manager,
                modules=modules,
                cloud_api_key=cloud_api_key,
            )
            duration_ms = round((time.perf_counter() - t0) * 1000)
            module_result = _finalize_module_data(name, module_result)
            module_result["duration_ms"] = duration_ms
            modules[name] = module_result
        except Exception as exc:
            duration_ms = round((time.perf_counter() - t0) * 1000)
            logger.warning("analyze_image module failed", details={"module": name, "error": str(exc)})
            modules[name] = {
                "status": MODULE_STATUS_FAILED,
                "duration_ms": duration_ms,
                "error": {"code": AI_SERVICE_ERROR, "message": str(exc)},
            }

    total_ms = round((time.perf_counter() - started_at) * 1000)
    return {
        "image_id": image_id,
        "duration_ms": total_ms,
        "data": modules,
    }


def _run_one_module(
    name: str,
    *,
    image_bgr: np.ndarray,
    rgb_image: np.ndarray,
    device: str,
    manager: Any,
    modules: Optional[Dict[str, Dict[str, Any]]] = None,
    cloud_api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """执行单个模块，返回统一模块结果结构（尚未做缺省键裁剪）。"""
    try:
        if name == "caption":
            # 无云 API Key 时直接视为模块禁用，不再尝试调用 provider
            if not cloud_api_key:
                return build_module_result(
                    status=MODULE_STATUS_FAILED,
                    error={"code": MODULE_DISABLED, "message": "caption module disabled: no cloud api key"},
                )
            configured_provider = getattr(settings, "CAPTION_PROVIDER", "local")
            resolved_provider = normalize_provider(configured_provider)
            provider = get_caption_provider(resolved_provider)
            if provider is None:
                if resolved_provider == "off":
                    return build_module_result(
                        status=MODULE_STATUS_FAILED,
                        error={"code": MODULE_DISABLED, "message": "caption module disabled"},
                    )
                return build_module_result(
                    status=MODULE_STATUS_FAILED,
                    error={"code": AI_SERVICE_ERROR, "message": "caption provider not available"},
                )
            out = provider.analyze(
                image_bgr,
                device=device,
                model_manager=manager,
                configured_provider=configured_provider,
                resolved_provider=resolved_provider,
                cloud_api_key=cloud_api_key,
            )
            st = out.get("status") or MODULE_STATUS_FAILED
            err = out.get("error") if isinstance(out.get("error"), dict) else None
            if st != MODULE_STATUS_SUCCESS:
                return build_module_result(
                    status=MODULE_STATUS_FAILED,
                    error=err or {"code": AI_SERVICE_ERROR, "message": "caption failed"},
                )
            data = out.get("data") or {}
            caption_text = str(data.get("description") or "").strip()
            keywords = data.get("keywords")
            subject_tags = data.get("subject_tags")
            action_tags = data.get("action_tags")
            scene_tags = data.get("scene_tags")
            ocr_text = str(data.get("ocr") or "").strip()
            merged = {
                "description": caption_text,
                "keywords": keywords or [],
                "subject_tags": subject_tags or [],
                "action_tags": action_tags or [],
                "scene_tags": scene_tags or [],
                "ocr": ocr_text,
                "face_count": _coerce_non_negative_int(data.get("face_count")),
                "person_count": _coerce_non_negative_int(data.get("person_count")),
            }
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=merged)

        if name == "person":
            from pipelines.person_pipeline import analyze_person

            data = analyze_person(image_bgr, device, manager)
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=data)
        if name == "quality":
            from pipelines.quality_pipeline import analyze_quality

            embedding_data = None
            if modules:
                embedding_module = modules.get("embedding") or {}
                if embedding_module.get("status") == "success":
                    embedding_data = embedding_module.get("data")
            out = analyze_quality(
                image_bgr,
                device,
                manager,
                embedding=embedding_data,
            )
            data = {
                "hashes": out.get("hashes", {}),
                "aesthetic_score": out.get("aesthetic_score", 0.0),
                "sharpness_score": out.get("sharpness_score", 0.0),
            }
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=data)
        if name == "embedding":
            from services.siglip_embedding_service import compute_siglip_embedding

            out = compute_siglip_embedding(rgb_image)
            if out and out.get("vector"):
                data = {"vector": out["vector"]}
                return build_module_result(status=MODULE_STATUS_SUCCESS, data=data)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                error={"code": AI_SERVICE_ERROR, "message": "图像编码失败"},
            )
    except Exception as e:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
        )
    return build_module_result(
        status=MODULE_STATUS_FAILED,
        error={"code": AI_SERVICE_ERROR, "message": "未知模块"},
    )


def _fail_response(
    *,
    image_id: Optional[str] = None,
    errors: List[Dict[str, str]],
) -> Dict[str, Any]:
    err = errors[0] if errors else {"code": IMAGE_DECODE_FAILED, "message": "unknown"}
    code = str(err.get("code") or IMAGE_DECODE_FAILED)
    msg = str(err.get("message") or "unknown")

    def _one() -> Dict[str, Any]:
        return {
            "status": MODULE_STATUS_FAILED,
            "duration_ms": 0,
            "error": {"code": code, "message": msg},
        }

    one = _one()
    return {
        "image_id": image_id,
        "duration_ms": 0,
        "data": {
            "embedding": dict(one),
            "person": dict(one),
            "quality": dict(one),
            "caption": dict(one),
        },
    }
