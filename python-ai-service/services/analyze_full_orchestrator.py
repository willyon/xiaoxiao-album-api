#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_full 编排器：串行执行各模块，聚合为统一返回结构。
Node 只读 response.modules；模块 status 仅为 success | failed。顶层 status 为 success | partial_success | failed（全部失败才 failed）。
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from constants.error_codes import AI_SERVICE_ERROR, IMAGE_DECODE_FAILED
from config import normalize_provider, settings
from logger import logger
from providers import get_caption_provider
from services.module_result import MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result

# 智能分析全流程固定顺序：caption（VLM 描述/标签）为主语义，其他模块为辅助
FULL_MODULE_ORDER = [
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


def run_analyze_full(
    image_bgr: np.ndarray,
    device: str,
    manager: Any,
    image_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    串行执行各分析模块，聚合为统一结构。
    返回含 image_id, status, modules, errors, timing。
    """
    if image_bgr is None or not isinstance(image_bgr, np.ndarray):
        return _fail_response(
            image_id=image_id,
            request_id=request_id,
            errors=[{"code": IMAGE_DECODE_FAILED, "message": "无效的图片数据"}],
        )
    module_names = FULL_MODULE_ORDER
    try:
        rgb_image = _bgr_to_rgb_safe(image_bgr)
    except Exception as exc:
        return _fail_response(
            image_id=image_id,
            request_id=request_id,
            errors=[{"code": IMAGE_DECODE_FAILED, "message": str(exc)}],
        )

    started_at = time.perf_counter()
    modules: Dict[str, Dict[str, Any]] = {}
    errors: List[Dict[str, str]] = []

    for name in module_names:
        t0 = time.perf_counter()
        try:
            module_result = _run_one_module(
                name,
                image_bgr=image_bgr,
                rgb_image=rgb_image,
                device=device,
                manager=manager,
                modules=modules,
            )
            duration_ms = round((time.perf_counter() - t0) * 1000)
            module_result["duration_ms"] = duration_ms
            modules[name] = module_result
            if module_result.get("status") == MODULE_STATUS_FAILED and isinstance(module_result.get("error"), dict):
                errors.append(module_result["error"])
        except Exception as exc:
            duration_ms = round((time.perf_counter() - t0) * 1000)
            logger.warning("analyze_full module failed", details={"module": name, "error": str(exc)})
            modules[name] = {
                "status": "failed",
                "data": None,
                "error": {"code": AI_SERVICE_ERROR, "message": str(exc)},
                "duration_ms": duration_ms,
            }
            errors.append({"code": AI_SERVICE_ERROR, "message": str(exc)})

    # 顶层 status：
    # - 只要没有 failed，就视为 success
    # - 全部 failed 才为 failed
    # - 其余混合场景为 partial_success
    statuses = [m["status"] for m in modules.values()]
    if all(s == "failed" for s in statuses):
        top_status = "failed"
    elif all(s != "failed" for s in statuses):
        top_status = "success"
    else:
        top_status = "partial_success"

    total_ms = round((time.perf_counter() - started_at) * 1000)
    return {
        "image_id": image_id,
        "status": top_status,
        "modules": modules,
        "errors": errors,
        "timing": {"total_ms": total_ms},
    }


def _run_one_module(
    name: str,
    *,
    image_bgr: np.ndarray,
    rgb_image: np.ndarray,
    device: str,
    manager: Any,
    modules: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """执行单个模块，返回统一模块结果结构。"""
    try:
        if name == "caption":
            configured_provider = getattr(settings, "CAPTION_PROVIDER", "local")
            resolved_provider = normalize_provider(configured_provider)
            provider = get_caption_provider(resolved_provider)
            if provider is None:
                out = build_module_result(
                    status=MODULE_STATUS_SUCCESS,
                    data={
                        "description": "",
                        "keywords": [],
                        "subject_tags": [],
                        "action_tags": [],
                        "scene_tags": [],
                        "ocr": "",
                        "face_count": 0,
                        "person_count": 0,
                    },
                )
            else:
                out = provider.analyze(
                    image_bgr,
                    device=device,
                    model_manager=manager,
                    configured_provider=configured_provider,
                    resolved_provider=resolved_provider,
                )
            data = out.get("data") or {}
            caption_text = str(data.get("description") or "").strip()
            keywords = data.get("keywords")
            subject_tags = data.get("subject_tags")
            action_tags = data.get("action_tags")
            scene_tags = data.get("scene_tags")
            ocr_text = str(data.get("ocr") or "").strip()
            out["data"] = {
                "description": caption_text,
                "keywords": keywords or [],
                "subject_tags": subject_tags or [],
                "action_tags": action_tags or [],
                "scene_tags": scene_tags or [],
                "ocr": ocr_text,
                "face_count": _coerce_non_negative_int(data.get("face_count")),
                "person_count": _coerce_non_negative_int(data.get("person_count")),
            }
            return out
        if name == "person":
            from pipelines.person_pipeline import analyze_person
            data = analyze_person(image_bgr, device, manager)
            return build_module_result(status="success", data=data)
        if name == "quality":
            from pipelines.quality_pipeline import analyze_cleanup
            embedding_data = None
            if modules:
                embedding_module = modules.get("embedding") or {}
                if embedding_module.get("status") == "success":
                    embedding_data = embedding_module.get("data")
            out = analyze_cleanup(
                image_bgr,
                device,
                manager,
                precomputed_embedding=embedding_data,
            )
            data = {
                "hashes": out.get("hashes", {}),
                "aesthetic_score": out.get("aesthetic_score", 0.0),
                "sharpness_score": out.get("sharpness_score", 0.0),
            }
            return build_module_result(status="success", data=data)
        if name == "embedding":
            from services.siglip_embedding_service import compute_siglip_embedding
            out = compute_siglip_embedding(rgb_image)
            if out and out.get("vector"):
                data = {"vector": out["vector"]}
                return build_module_result(status="success", data=data)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data={},
                error={"code": AI_SERVICE_ERROR, "message": "图像编码失败"},
            )
    except Exception as e:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data={},
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
        )
    return build_module_result(
        status=MODULE_STATUS_FAILED,
        data={},
        error={"code": AI_SERVICE_ERROR, "message": "未知模块"},
    )


def _fail_response(
    *,
    image_id: Optional[str] = None,
    request_id: Optional[str] = None,
    errors: List[Dict[str, str]],
) -> Dict[str, Any]:
    return {
        "image_id": image_id,
        "status": "failed",
        "modules": {},
        "errors": errors,
        "timing": {},
    }
