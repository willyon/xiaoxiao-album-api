#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云模型「测试连接」接口."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel, Field

from config import settings
from logger import logger
from providers.qwen_common import (
    DEFAULT_QWEN_COMPATIBLE_BASE_URL,
    extract_openai_message_text,
    post_json,
)


router = APIRouter()


class CloudTestRequest(BaseModel):
    apiKey: str = Field("", description="待测试的云模型 API Key")


def _build_response(ok: bool, message: str) -> Dict[str, Any]:
    return {"ok": bool(ok), "message": str(message or "").strip() or ("连接成功" if ok else "连接失败")}


@router.post("/cloud/test-connection")
async def test_cloud_connection(body: CloudTestRequest):
    """
    使用用户提供的 API Key 调用千问兼容接口做一次最小真实调用：
    - 模型：qwen-flash（轻量、成本低）
    - 提示：回复 "ok"
    """
    api_key = (body.apiKey or "").strip()
    if not api_key:
        return _build_response(False, "请输入有效的 API Key 后再测试。")

    base = (getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "").strip() or DEFAULT_QWEN_COMPATIBLE_BASE_URL
    url = base.rstrip("/") + "/chat/completions"
    model = getattr(settings, "VIDEO_MERGE_TEXT_MODEL", "qwen-flash") or "qwen-flash"

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "请只回复：ok"}],
        "max_tokens": 8,
        "temperature": 0,
    }

    try:
        timeout = float(getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0) or 30.0)
        resp = post_json(url, payload, api_key, timeout_seconds=timeout)
        text = extract_openai_message_text(resp)
        text = (text or "").strip().lower()
        if "ok" in text:
            return _build_response(True, "连接成功，可以保存。")
        return _build_response(False, "云模型返回异常结果，请检查 API Key 或稍后重试。")
    except Exception as exc:
        logger.warning("cloud test connection failed", details={"error": str(exc)})
        msg = str(exc).lower()
        if "invalid api key" in msg or "authentication" in msg:
            return _build_response(False, "API Key 无效或已失效，请检查后重试。")
        if "permission" in msg or "forbidden" in msg:
            return _build_response(False, "当前 API Key 没有权限调用该模型。")
        if "quota" in msg or "rate limit" in msg:
            return _build_response(False, "当前账户额度不足或达到调用上限。")
        return _build_response(False, "无法连接云模型服务，请检查网络或稍后再试。")

