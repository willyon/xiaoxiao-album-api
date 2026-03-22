#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一模块结果工具。
用于 analyze_full 各模块：status 仅为 success | failed。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

MODULE_STATUS_FAILED = "failed"
MODULE_STATUS_SUCCESS = "success"

MODULE_STATUS_SET = {
    MODULE_STATUS_FAILED,
    MODULE_STATUS_SUCCESS,
}


def build_module_result(
    *,
    status: str,
    data: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """构造统一模块结果对象。"""
    safe_status = status if status in MODULE_STATUS_SET else MODULE_STATUS_FAILED
    safe_data = data if isinstance(data, dict) else {}
    safe_error = error if isinstance(error, dict) else None
    return {
        "status": safe_status,
        "data": safe_data,
        "error": safe_error,
    }
