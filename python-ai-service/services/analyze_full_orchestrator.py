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
from config import normalize_ocr_trigger_mode, normalize_provider, settings
from logger import logger
from providers import get_caption_provider, get_ocr_provider
from services.module_result import (
    MODULE_STATUS_DISABLED,
    MODULE_STATUS_FAILED,
    MODULE_STATUS_SKIPPED,
    build_module_result,
)
from services.ocr_trigger_service import collect_ocr_trigger_signals, should_run_ocr

# 智能分析全流程固定顺序：caption 为主语义，其他模块为辅助；profile 仅影响各节点内部模型/逻辑
FULL_MODULE_ORDER = [
    "embedding",
    "person",
    "quality",
    "caption",
    "ocr",
]

PIPELINE_VERSION = "image-analysis-v1"


def run_analyze_full(
    image_bgr: np.ndarray,
    profile: str,
    device: str,
    manager: Any,
    image_id: Optional[str] = None,
    request_id: Optional[str] = None,
    force_ocr: bool = False,
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
    if profile not in ("standard", "enhanced"):
        profile = "standard"
    module_names = FULL_MODULE_ORDER
    rgb_image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    task_id = str(uuid.uuid4())
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
                profile=profile,
                device=device,
                manager=manager,
                modules=modules,
                force_ocr=force_ocr,
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
                "reason": "module_exception",
                "meta": {},
                "duration_ms": duration_ms,
            }
            errors.append({"code": AI_SERVICE_ERROR, "message": str(exc)})

    # 顶层 status：
    # - 只要没有 failed，就视为 success（允许 disabled/skipped/empty）
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
        "task_id": task_id,
        "image_id": image_id,
        "status": top_status,
        "profile": profile,
        "pipeline_version": PIPELINE_VERSION,
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
    modules: Optional[Dict[str, Dict[str, Any]]] = None,
    force_ocr: bool = False,
) -> Dict[str, Any]:
    """执行单个模块，返回统一模块结果结构。"""
    try:
        if name == "caption":
            configured_provider = getattr(settings, "CAPTION_PROVIDER", "local")
            resolved_provider = normalize_provider(configured_provider)
            provider = get_caption_provider(resolved_provider)
            if provider is None:
                out = build_module_result(
                    status=MODULE_STATUS_DISABLED,
                    data={
                        "caption": "",
                        "keywords": [],
                        "subject_tags": [],
                        "action_tags": [],
                        "scene_tags": [],
                    },
                    reason="provider_off",
                    meta={
                        "configured_provider": configured_provider,
                        "resolved_provider": resolved_provider,
                    },
                )
            else:
                out = provider.analyze(
                    image_bgr,
                    profile=profile,
                    device=device,
                    model_manager=manager,
                    configured_provider=configured_provider,
                    resolved_provider=resolved_provider,
                )
            data = out.get("data") or {}
            caption = data.get("caption", "") or ""
            keywords = data.get("keywords")
            subject_tags = data.get("subject_tags")
            action_tags = data.get("action_tags")
            scene_tags = data.get("scene_tags")
            out["data"] = {
                "caption": caption,
                "keywords": keywords or [],
                "subject_tags": subject_tags or [],
                "action_tags": action_tags or [],
                "scene_tags": scene_tags or [],
            }
            out.setdefault("meta", {})
            out["meta"]["configured_provider"] = configured_provider
            out["meta"]["resolved_provider"] = resolved_provider
            return out
        if name == "person":
            from pipelines.person_pipeline import analyze_person
            data = analyze_person(image_bgr, profile, device, manager)
            return build_module_result(status="success", data=data, meta={})
        if name == "ocr":
            configured_provider = getattr(settings, "OCR_PROVIDER", "local")
            resolved_provider = normalize_provider(configured_provider)
            trigger_mode = normalize_ocr_trigger_mode(getattr(settings, "OCR_TRIGGER_MODE", "always"))
            caption_module = (modules or {}).get("caption") if modules else None

            if resolved_provider == "off":
                out = build_module_result(
                    status=MODULE_STATUS_DISABLED,
                    data={"blocks": []},
                    reason="provider_off",
                    meta={
                        "configured_provider": configured_provider,
                        "resolved_provider": resolved_provider,
                        "trigger_mode": trigger_mode,
                        "trigger_signals": {},
                    },
                )
            elif trigger_mode == "off":
                out = build_module_result(
                    status=MODULE_STATUS_SKIPPED,
                    data={"blocks": []},
                    reason="trigger_off",
                    meta={
                        "configured_provider": configured_provider,
                        "resolved_provider": resolved_provider,
                        "trigger_mode": trigger_mode,
                        "trigger_signals": {},
                    },
                )
            else:
                trigger_signals = (
                    collect_ocr_trigger_signals(
                        image_bgr,
                        force_ocr=force_ocr,
                        caption_module=caption_module,
                        provider_policy_requires_ocr=False,
                    )
                    if trigger_mode == "smart"
                    else {}
                )
                if trigger_mode == "smart" and not should_run_ocr(trigger_mode, trigger_signals):
                    return build_module_result(
                        status=MODULE_STATUS_SKIPPED,
                        data={"blocks": []},
                        reason="not_triggered",
                        meta={
                            "configured_provider": configured_provider,
                            "resolved_provider": resolved_provider,
                            "trigger_mode": trigger_mode,
                            "trigger_signals": trigger_signals,
                        },
                    )
                provider = get_ocr_provider(resolved_provider)
                if provider is None:
                    out = build_module_result(
                        status=MODULE_STATUS_FAILED,
                        data={"blocks": []},
                        error={"code": AI_SERVICE_ERROR, "message": f"ocr provider unavailable: {resolved_provider}"},
                        reason="provider_unavailable",
                        meta={
                            "configured_provider": configured_provider,
                            "resolved_provider": resolved_provider,
                            "trigger_mode": trigger_mode,
                            "trigger_signals": trigger_signals,
                        },
                    )
                else:
                    out = provider.recognize(
                        image_bgr,
                        profile=profile,
                        device=device,
                        model_manager=manager,
                        configured_provider=configured_provider,
                        resolved_provider=resolved_provider,
                        trigger_mode=trigger_mode,
                        trigger_signals=trigger_signals,
                    )
            return out
        if name == "quality":
            from pipelines.quality_pipeline import analyze_cleanup
            embedding_data = None
            if modules:
                embedding_module = modules.get("embedding") or {}
                if embedding_module.get("status") == "success":
                    embedding_data = embedding_module.get("data")
            out = analyze_cleanup(
                image_bgr,
                profile,
                device,
                manager,
                precomputed_embedding=embedding_data,
            )
            data = {
                "hashes": out.get("hashes", {}),
                "aesthetic_score": out.get("aesthetic_score", 0.0),
                "sharpness_score": out.get("sharpness_score", 0.0),
            }
            return build_module_result(status="success", data=data, meta={})
        if name == "embedding":
            from services.siglip_embedding_service import compute_siglip_embedding
            out = compute_siglip_embedding(rgb_image, profile=profile)
            if out and out.get("vector"):
                data = {"vector": out["vector"], "model": out.get("model", "siglip2")}
                return build_module_result(status="success", data=data, meta={})
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data={},
                error={"code": AI_SERVICE_ERROR, "message": "图像编码失败"},
                reason="embedding_failed",
                meta={},
            )
    except Exception as e:
        return build_module_result(
            status=MODULE_STATUS_FAILED,
            data={},
            error={"code": AI_SERVICE_ERROR, "message": str(e)},
            reason="module_exception",
            meta={},
        )
    return build_module_result(
        status=MODULE_STATUS_FAILED,
        data={},
        error={"code": AI_SERVICE_ERROR, "message": "未知模块"},
        reason="unknown_module",
        meta={},
    )


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
        "modules": {},
        "errors": errors,
        "timing": {},
        "created_at": datetime.now(tz=timezone.utc).isoformat(),
    }
