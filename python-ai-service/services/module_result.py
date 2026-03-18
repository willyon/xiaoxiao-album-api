#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一模块结果工具。
用于 analyze_full 中 caption / ocr 等模块的状态语义构造与最小有效结果判断。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

MODULE_STATUS_DISABLED = "disabled"
MODULE_STATUS_SKIPPED = "skipped"
MODULE_STATUS_EMPTY = "empty"
MODULE_STATUS_FAILED = "failed"
MODULE_STATUS_SUCCESS = "success"

MODULE_STATUS_SET = {
    MODULE_STATUS_DISABLED,
    MODULE_STATUS_SKIPPED,
    MODULE_STATUS_EMPTY,
    MODULE_STATUS_FAILED,
    MODULE_STATUS_SUCCESS,
}


def build_module_result(
    *,
    status: str,
    data: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, str]] = None,
    reason: str = "",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构造统一模块结果对象。"""
    safe_status = status if status in MODULE_STATUS_SET else MODULE_STATUS_FAILED
    safe_data = data if isinstance(data, dict) else {}
    safe_error = error if isinstance(error, dict) else None
    safe_reason = str(reason or "").strip()
    safe_meta = meta if isinstance(meta, dict) else {}
    return {
        "status": safe_status,
        "data": safe_data,
        "error": safe_error,
        "reason": safe_reason,
        "meta": safe_meta,
    }


def is_caption_effective(data: Optional[Dict[str, Any]]) -> bool:
    """caption 只要 caption 非空，或 keywords 任一非空，即视为有效结果。"""
    if not isinstance(data, dict):
        return False
    caption = str(data.get("caption") or "").strip()
    keywords = data.get("keywords") or []
    return bool(caption) or bool(keywords)


def is_ocr_effective(data: Optional[Dict[str, Any]]) -> bool:
    """OCR 只要 blocks 非空，即视为有效结果。"""
    if not isinstance(data, dict):
        return False
    blocks = data.get("blocks") or []
    return isinstance(blocks, list) and len(blocks) > 0
