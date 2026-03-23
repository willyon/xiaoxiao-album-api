#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一模块结果工具。
用于 analyze_image 各模块：status 仅为 success | failed。
成功：仅含 status（及可选 data）；失败：仅含 status 与 error，不含 data。
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
    """构造统一模块结果对象。成功时不含 error；失败时不含 data（忽略调用方传入的 data）。"""
    safe_status = status if status in MODULE_STATUS_SET else MODULE_STATUS_FAILED
    out: Dict[str, Any] = {"status": safe_status}
    if safe_status == MODULE_STATUS_SUCCESS:
        safe_data = data if isinstance(data, dict) else {}
        if safe_data:
            out["data"] = safe_data
    else:
        safe_error = error if isinstance(error, dict) else None
        if safe_error:
            out["error"] = safe_error
    return out
