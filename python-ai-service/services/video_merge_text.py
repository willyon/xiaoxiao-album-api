#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多帧 caption 描述合并为一段视频级摘要（纯文本 LLM，与帧级 VL 分离）。
失败时回退为简单拼接。
"""

from __future__ import annotations

from typing import List

from config import settings
from logger import logger
from providers.qwen_common import DEFAULT_QWEN_COMPATIBLE_BASE_URL, extract_openai_message_text, post_json


def merge_frame_descriptions_to_video_summary(frame_descriptions: List[str]) -> str:
    """
    将若干帧的中文/英文描述合并为一段简洁视频摘要。
    """
    texts = [str(t or "").strip() for t in frame_descriptions if t and str(t).strip()]
    if not texts:
        return ""
    if len(texts) == 1:
        return texts[0]

    if not getattr(settings, "VIDEO_MERGE_TEXT_ENABLE", True):
        return _fallback_join(texts)

    api_key = (getattr(settings, "CAPTION_CLOUD_API_KEY", "") or getattr(settings, "CLOUD_API_KEY", "") or "").strip()
    if not api_key:
        logger.info("video_merge_text: no API key, using fallback join")
        return _fallback_join(texts)

    base = (getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "").strip() or DEFAULT_QWEN_COMPATIBLE_BASE_URL
    url = base.rstrip("/") + "/chat/completions"
    model = getattr(settings, "VIDEO_MERGE_TEXT_MODEL", "qwen-flash") or "qwen-flash"
    # 控制总输入长度，避免 token 爆炸
    lines = []
    for i, t in enumerate(texts[:20]):
        lines.append(f"[{i + 1}] {t[:400]}")
    user_content = (
        "下面是同一视频在不同时刻的若干帧画面描述（可能重复）。"
        "请合并为一段简洁的视频内容摘要（1～4 句中文），不要逐条复述，不要编号：\n"
        + "\n".join(lines)
    )
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": user_content}],
        "temperature": 0.3,
        "max_tokens": 512,
    }
    try:
        timeout = float(getattr(settings, "VIDEO_MERGE_TIMEOUT_SECONDS", 60))
        resp = post_json(url, payload, api_key.strip(), timeout_seconds=timeout)
        text = extract_openai_message_text(resp)
        text = str(text or "").strip()
        if text:
            return text
    except Exception as exc:
        logger.warning("video_merge_text: llm failed", details={"error": str(exc)})

    return _fallback_join(texts)


def _fallback_join(texts: List[str]) -> str:
    """回退：取首段 + 略去重复前缀的简单合并。"""
    if not texts:
        return ""
    if len(texts) == 1:
        return texts[0]
    # 用分号连接前几条，总长度限制
    parts = texts[:5]
    merged = "；".join(parts)
    return merged[:3000]
