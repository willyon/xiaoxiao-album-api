#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多帧 caption 描述合并为一段视频级摘要（纯文本 LLM，与帧级 VL 分离）。
失败时回退为简单拼接。
"""

from __future__ import annotations

from typing import List, Optional

from config import settings
from logger import logger
from services.cloud_caption_client import call_qwen_text_summary


def merge_frame_descriptions_to_video_summary(
    frame_descriptions: List[str],
    *,
    api_key: Optional[str] = None,
) -> str:
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

    effective_api_key = (api_key or "").strip()
    if not effective_api_key:
        logger.info("video_merge_text: no API key, using fallback join")
        return _fallback_join(texts)

    # 控制总输入长度，避免 token 爆炸
    lines = []
    for i, t in enumerate(texts[:20]):
        lines.append(f"[{i + 1}] {t[:400]}")
    user_content = (
        "下面是同一视频在不同时刻的若干帧画面描述（可能重复）。"
        "请合并为一段简洁的视频内容摘要（1～4 句中文），不要逐条复述，不要编号：\n"
        + "\n".join(lines)
    )
    try:
        timeout = float(getattr(settings, "VIDEO_MERGE_TIMEOUT_SECONDS", 60))
        text = call_qwen_text_summary(
            system_prompt="你是一个视频内容摘要助手，只需输出简洁的中文描述。",
            user_content=user_content,
            api_key=effective_api_key,
            timeout_seconds=timeout,
        )
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
