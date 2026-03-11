#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一错误响应体
与 Node 约定一致：{ "error_code": "XXX", "error_message": "..." }
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class ErrorBody(BaseModel):
    """接口异常时返回的 JSON body"""

    error_code: str
    error_message: Optional[str] = None
