#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端 caption / 文本摘要统一调用客户端。

当前仅支持千问兼容接口：
- 图像 caption：多模态 chat/completions，返回标准 JSON 文本，由上层解析
- 文本摘要：纯文本 chat/completions，返回字符串

不做本地降级：无 API Key 或调用失败时由上层决定 MODULE_DISABLED 或回退策略。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from config import settings
from logger import logger
from providers.qwen_common import (
    DEFAULT_QWEN_COMPATIBLE_BASE_URL,
    extract_openai_message_text,
    post_json,
    resolve_endpoint,
)
from utils.errors import AiServiceError, AiTimeoutError


def _normalize_api_key(raw: Optional[str]) -> str:
  return (raw or "").strip()


def call_qwen_vision_json(
    *,
    image_data_url: str,
    prompt: str,
    api_key: Optional[str],
) -> Dict[str, Any]:
    """调用千问多模态 chat/completions，要求返回 JSON 文本。"""
    key = _normalize_api_key(api_key)
    if not key:
        raise AiServiceError("cloud caption api key missing")

    model = getattr(settings, "CAPTION_CLOUD_MODEL", "qwen3-vl-plus")
    endpoint = resolve_endpoint(
        getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "",
        DEFAULT_QWEN_COMPATIBLE_BASE_URL,
        "chat/completions",
    )
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "max_tokens": int(getattr(settings, "CAPTION_MAX_TOKENS", 150) or 150),
    }
    try:
        timeout = float(getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0) or 30.0)
        resp = post_json(endpoint, payload, key, timeout_seconds=timeout)
        text = extract_openai_message_text(resp)
        return {"raw_text": text}
    except AiTimeoutError:
        raise
    except AiServiceError:
        raise
    except Exception as exc:
        logger.warning("cloud_caption_client.call_qwen_vision_json unexpected error", details={"error": str(exc)})
        raise AiServiceError(str(exc))


def call_qwen_text_summary(
    *,
    system_prompt: str,
    user_content: str,
    api_key: Optional[str],
    timeout_seconds: float,
) -> str:
    """调用千问文本 chat/completions，返回纯文本摘要。"""
    key = _normalize_api_key(api_key)
    if not key:
        raise AiServiceError("cloud text api key missing")

    base = (getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "").strip() or DEFAULT_QWEN_COMPATIBLE_BASE_URL
    url = base.rstrip("/") + "/chat/completions"
    model_name = getattr(settings, "VIDEO_MERGE_TEXT_MODEL", "qwen-flash")
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.3,
        "max_tokens": 512,
    }
    resp = post_json(url, payload, key, timeout_seconds=timeout_seconds)
    text = extract_openai_message_text(resp)
    return str(text or "").strip()

