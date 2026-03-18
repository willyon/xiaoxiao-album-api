#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千问 caption provider 实现。"""

from __future__ import annotations

from typing import Any, Dict

from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT
from logger import logger
from services.module_result import MODULE_STATUS_EMPTY, MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result, is_caption_effective
from config import settings
from providers.base import BaseCaptionProvider
from providers.qwen_common import (
    DEFAULT_QWEN_COMPATIBLE_BASE_URL,
    encode_image_to_data_url,
    extract_openai_message_text,
    normalize_keywords,
    parse_json_object_from_text,
    post_json,
    resolve_endpoint,
)
from utils.errors import AiServiceError, AiTimeoutError


class QwenCaptionProvider(BaseCaptionProvider):
    def analyze(
        self,
        image: Any,
        *,
        profile: str,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
    ) -> Dict[str, Any]:
        base_data = {"caption": "", "keywords": []}
        configured_vendor = getattr(settings, "CAPTION_CLOUD_VENDOR", "qwen")
        model = getattr(settings, "CAPTION_CLOUD_MODEL", "") or "qwen3-vl-plus"
        endpoint = resolve_endpoint(
            getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "",
            DEFAULT_QWEN_COMPATIBLE_BASE_URL,
            "chat/completions",
        )
        meta = {
            "configured_provider": configured_provider,
            "resolved_provider": resolved_provider,
            "configured_vendor": configured_vendor,
            "resolved_vendor": "qwen",
            "model": model,
        }

        api_key = (getattr(settings, "CAPTION_CLOUD_API_KEY", "") or "").strip()
        if not api_key:
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": "caption cloud api key missing"},
                reason="credentials_missing",
                meta=meta,
            )

        prompt = (
            "请分析这张图片，并严格输出一个 JSON 对象，不要输出 Markdown 或额外解释。"
            'JSON 结构必须为 {"caption":"", "keywords":[]}。'
            "caption 用一到两句简体中文客观描述图片主要内容；"
            "keywords 输出 3 到 8 个简短关键词；"
            "若无法判断，请返回空字符串和空数组。"
        )
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": encode_image_to_data_url(image)}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": int(getattr(settings, "CAPTION_MAX_TOKENS", 128) or 128),
        }

        try:
            response = post_json(endpoint, payload, api_key, float(getattr(settings, "CAPTION_TIMEOUT_SECONDS", 10.0) or 10.0))
            raw_text = extract_openai_message_text(response)
            data = _coerce_caption_response(raw_text)
            logger.info(
                "qwen_caption.success",
                details={"profile": profile, "model": model, "has_caption": bool(data.get("caption")), "keyword_count": len(data.get("keywords") or [])},
            )
            if is_caption_effective(data):
                return build_module_result(status=MODULE_STATUS_SUCCESS, data=data, meta=meta)
            return build_module_result(
                status=MODULE_STATUS_EMPTY,
                data=data,
                reason="no_caption_generated",
                meta=meta,
            )
        except AiTimeoutError as exc:
            logger.warning("qwen caption timeout: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_TIMEOUT, "message": str(exc)},
                reason="provider_timeout",
                meta=meta,
            )
        except AiServiceError as exc:
            logger.warning("qwen caption failed: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
                reason="provider_exception",
                meta=meta,
            )
        except Exception as exc:
            logger.warning("qwen caption unexpected error: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
                reason="provider_exception",
                meta=meta,
            )


def _coerce_caption_response(raw_text: str) -> Dict[str, Any]:
    obj = parse_json_object_from_text(raw_text)
    if isinstance(obj, dict):
        caption = str(obj.get("caption") or "").strip()
        keywords = normalize_keywords(obj.get("keywords") or [])
        return {
            "caption": caption,
            "keywords": list(keywords),
        }
    caption = str(raw_text or "").strip()
    return {
        "caption": caption,
        "keywords": [],
    }
