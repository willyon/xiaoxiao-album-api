#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千问 OCR provider 实现。"""

from __future__ import annotations

from typing import Any, Dict, List

from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT
from logger import logger
from services.module_result import MODULE_STATUS_EMPTY, MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result, is_ocr_effective
from config import settings
from providers.base import BaseOcrProvider
from providers.qwen_common import (
    DEFAULT_QWEN_MULTIMODAL_BASE_URL,
    encode_image_to_data_url,
    extract_qwen_output_content,
    extract_qwen_output_text,
    polygon_to_bbox,
    post_json,
    resolve_endpoint,
    rotate_rect_to_bbox,
)
from utils.errors import AiServiceError, AiTimeoutError


class QwenOcrProvider(BaseOcrProvider):
    def recognize(
        self,
        image: Any,
        *,
        profile: str,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
        trigger_mode: str,
        trigger_signals: Dict[str, Any],
    ) -> Dict[str, Any]:
        base_data = {"blocks": []}
        configured_vendor = getattr(settings, "OCR_CLOUD_VENDOR", "qwen")
        model = getattr(settings, "OCR_CLOUD_MODEL", "") or "qwen-vl-ocr"
        endpoint = resolve_endpoint(
            getattr(settings, "OCR_CLOUD_BASE_URL", "") or "",
            DEFAULT_QWEN_MULTIMODAL_BASE_URL,
            "services/aigc/multimodal-generation/generation",
        )
        meta = {
            "configured_provider": configured_provider,
            "resolved_provider": resolved_provider,
            "configured_vendor": configured_vendor,
            "resolved_vendor": "qwen",
            "model": model,
            "trigger_mode": trigger_mode,
            "trigger_signals": trigger_signals,
        }

        api_key = (getattr(settings, "OCR_CLOUD_API_KEY", "") or "").strip()
        if not api_key:
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": "ocr cloud api key missing"},
                reason="credentials_missing",
                meta=meta,
            )

        payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "image": encode_image_to_data_url(image),
                                "min_pixels": 3072,
                                "max_pixels": 8388608,
                                "enable_rotate": False,
                            }
                        ],
                    }
                ]
            },
        }

        try:
            response = post_json(endpoint, payload, api_key, float(getattr(settings, "OCR_TIMEOUT_SECONDS", 5.0) or 5.0))
            blocks = _extract_blocks(response)
            if not blocks:
                blocks = _extract_text_only_blocks(response)
            data = {"blocks": blocks}
            logger.info(
                "qwen_ocr.success",
                details={"profile": profile, "model": model, "block_count": len(data["blocks"])},
            )
            if is_ocr_effective(data):
                return build_module_result(status=MODULE_STATUS_SUCCESS, data=data, meta=meta)
            return build_module_result(
                status=MODULE_STATUS_EMPTY,
                data=data,
                reason="no_text_detected",
                meta=meta,
            )
        except AiTimeoutError as exc:
            logger.warning("qwen ocr timeout: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_TIMEOUT, "message": str(exc)},
                reason="provider_timeout",
                meta=meta,
            )
        except AiServiceError as exc:
            logger.warning("qwen ocr failed: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
                reason="provider_exception",
                meta=meta,
            )
        except Exception as exc:
            logger.warning("qwen ocr unexpected error: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
                reason="provider_exception",
                meta=meta,
            )


def _extract_blocks(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    content = extract_qwen_output_content(response)
    if not content:
        return []
    blocks: List[Dict[str, Any]] = []
    for entry in content:
        if not isinstance(entry, dict):
            continue
        ocr_result = entry.get("ocr_result") or {}
        words_info = ocr_result.get("words_info") or []
        for item in words_info:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            bbox = polygon_to_bbox(item.get("location")) or rotate_rect_to_bbox(item.get("rotate_rect"))
            if len(bbox) != 4:
                continue
            confidence_raw = item.get("confidence")
            try:
                confidence = float(confidence_raw) if confidence_raw is not None else 1.0
            except Exception:
                confidence = 1.0
            blocks.append(
                {
                    "text": text,
                    "bbox": bbox,
                    "confidence": confidence,
                }
            )
    return blocks


def _extract_text_only_blocks(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_text = extract_qwen_output_text(response)
    if not raw_text:
        return []
    lines: List[str] = []
    seen: set[str] = set()
    for raw_line in str(raw_text).splitlines():
        line = " ".join(str(raw_line).strip().split())
        if not line or line in {"```", "json", "```json"}:
            continue
        if line in seen:
            continue
        seen.add(line)
        lines.append(line)
    if not lines:
        lines = [str(raw_text).strip()]
    return [
        {
            "text": line,
            "bbox": None,
            "confidence": None,
        }
        for line in lines
        if line
    ]
