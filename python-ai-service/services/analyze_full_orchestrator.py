#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_full 编排器：按 profile 串行执行各模块，聚合为统一返回结构。
Node 只读 response.modules；顶层 status 为 success | partial_success | failed（全部失败才 failed）。
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from constants.error_codes import AI_SERVICE_ERROR, IMAGE_DECODE_FAILED, MODULE_TIMEOUT
from logger import logger

PROFILE_MAP = {
    "basic": ["caption", "scene"],
    "standard": ["caption", "scene", "objects", "person"],
    "full": ["caption", "scene", "objects", "person", "ocr", "quality", "embedding"],
}

PIPELINE_VERSION = "image-analysis-v1"


def run_analyze_full(
    image_bgr: np.ndarray,
    profile: str,
    device: str,
    manager: Any,
    image_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    串行执行 profile 对应模块，聚合为统一结构。
    返回含 task_id, image_id, status, profile, pipeline_version, modules, errors, timing, created_at。
    """
    if image_bgr is None or not isinstance(image_bgr, np.ndarray):
        return _fail_response(
            image_id=image_id,
            request_id=request_id,
            profile=profile,
            errors=[{"code": IMAGE_DECODE_FAILED, "message": "无效的图片数据"}],
        )

    profile = (profile or "standard").lower()
    if profile not in PROFILE_MAP:
        profile = "standard"
    module_names = PROFILE_MAP[profile]
    rgb_image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    task_id = str(uuid.uuid4())
    started_at = time.perf_counter()
    modules: Dict[str, Dict[str, Any]] = {}
    errors: List[Dict[str, str]] = []

    for name in module_names:
        t0 = time.perf_counter()
        try:
            status, data, err = _run_one_module(
                name, image_bgr=image_bgr, rgb_image=rgb_image, profile=profile, device=device, manager=manager
            )
            duration_ms = round((time.perf_counter() - t0) * 1000)
            modules[name] = {
                "status": status,
                "data": data,
                "error": {"code": err[0], "message": err[1]} if err else None,
                "duration_ms": duration_ms,
            }
            if err:
                errors.append({"code": err[0], "message": err[1]})
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

    # 顶层 status：全部失败才 failed
    statuses = [m["status"] for m in modules.values()]
    if all(s == "failed" for s in statuses):
        top_status = "failed"
    elif all(s == "success" for s in statuses):
        top_status = "success"
    else:
        top_status = "partial_success"

    total_ms = round((time.perf_counter() - started_at) * 1000)
    return {
        "task_id": task_id,
        "image_id": image_id,
        "status": top_status,
        "profile": profile,
        "pipeline_version": PIPELINE_VERSION,
        "module_versions": {},
        "modules": modules,
        "errors": errors,
        "timing": {"total_ms": total_ms},
        "created_at": datetime.now(tz=timezone.utc).isoformat(),
    }


def _run_one_module(
    name: str,
    *,
    image_bgr: np.ndarray,
    rgb_image: np.ndarray,
    profile: str,
    device: str,
    manager: Any,
) -> tuple[str, Any, Optional[tuple[str, str]]]:
    """执行单个模块，返回 (status, data, error_tuple or None)。"""
    try:
        if name == "caption":
            from pipelines.caption_pipeline import analyze_caption
            out = analyze_caption(image_bgr, profile, device, manager)
            data = {"text": out.get("caption", ""), "keywords": out.get("keywords", [])}
            return ("success", data, None)
        if name == "scene":
            from pipelines.scene_pipeline import analyze_scene
            out = analyze_scene(image_bgr, profile, device, manager)
            data = {
                "primary_scene": out.get("primary_scene"),
                "scene_tags": out.get("scene_tags", []),
                "confidence": out.get("confidence", 0.0),
            }
            return ("success", data, None)
        if name == "objects":
            from pipelines.object_pipeline import analyze_objects
            out = analyze_objects(image_bgr, profile, device, manager)
            data = out.get("objects", [])
            return ("success", data, None)
        if name == "person":
            from pipelines.person_pipeline import analyze_person
            data = analyze_person(image_bgr, profile, device, manager)
            return ("success", data, None)
        if name == "ocr":
            from pipelines.ocr_pipeline import analyze_ocr
            out = analyze_ocr(image_bgr, profile, device, manager)
            data = {"blocks": out.get("blocks", [])}
            return ("success", data, None)
        if name == "quality":
            from pipelines.quality_pipeline import analyze_cleanup
            out = analyze_cleanup(image_bgr, profile, device, manager)
            data = {
                "hashes": out.get("hashes", {}),
                "aesthetic_score": out.get("aesthetic_score", 0.0),
                "sharpness_score": out.get("sharpness_score", 0.0),
            }
            return ("success", data, None)
        if name == "embedding":
            from services.siglip_embedding_service import compute_siglip_embedding
            out = compute_siglip_embedding(rgb_image, profile=profile)
            if out and out.get("vector"):
                data = {"vector": out["vector"], "model": out.get("model", "siglip2")}
                return ("success", data, None)
            return ("failed", None, (AI_SERVICE_ERROR, "图像编码失败"))
    except Exception as e:
        return ("failed", None, (AI_SERVICE_ERROR, str(e)))
    return ("failed", None, (AI_SERVICE_ERROR, "未知模块"))


def _fail_response(
    *,
    image_id: Optional[str] = None,
    request_id: Optional[str] = None,
    profile: str = "standard",
    errors: List[Dict[str, str]],
) -> Dict[str, Any]:
    return {
        "task_id": str(uuid.uuid4()),
        "image_id": image_id,
        "status": "failed",
        "profile": profile,
        "pipeline_version": PIPELINE_VERSION,
        "module_versions": {},
        "modules": {},
        "errors": errors,
        "timing": {},
        "created_at": datetime.now(tz=timezone.utc).isoformat(),
    }
