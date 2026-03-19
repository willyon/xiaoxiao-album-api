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
        base_data = {
            "caption": "",
            "keywords": [],
            "subject_tags": [],
            "action_tags": [],
            "scene_tags": [],
        }
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
            'JSON 结构必须为 {"caption":"","keywords":[],"subject_tags":[],"action_tags":[],"scene_tags":[]}。'
            "caption 用一到两句简体中文客观描述图片主要内容，并尽量说清主体、动作和场景；"
            "keywords 输出 4 到 10 个简短关键词；"
            "subject_tags 输出 1 到 4 个主体标签，如宝宝、妈妈、爸爸、多人；"
            "action_tags 输出 1 到 4 个动作标签，如吃饭、睡觉、玩耍、抱着、看电视；"
            "scene_tags 输出 1 到 6 个场景或物件标签，如餐椅、卧室、客厅、户外、婴儿车；"
            "标签应为简短中文短语，避免重复，避免输出完整句子；"
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
                details={
                    "profile": profile,
                    "model": model,
                    "has_caption": bool(data.get("caption")),
                    "keyword_count": len(data.get("keywords") or []),
                    "subject_tag_count": len(data.get("subject_tags") or []),
                    "action_tag_count": len(data.get("action_tags") or []),
                    "scene_tag_count": len(data.get("scene_tags") or []),
                },
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
        subject_tags = normalize_keywords(obj.get("subject_tags") or [])
        action_tags = normalize_keywords(obj.get("action_tags") or [])
        scene_tags = normalize_keywords(obj.get("scene_tags") or [])
        return {
            "caption": caption,
            "keywords": list(keywords),
            "subject_tags": list(subject_tags),
            "action_tags": list(action_tags),
            "scene_tags": list(scene_tags),
        }
    caption = str(raw_text or "").strip()
    return {
        "caption": caption,
        "keywords": [],
        "subject_tags": [],
        "action_tags": [],
        "scene_tags": [],
    }
