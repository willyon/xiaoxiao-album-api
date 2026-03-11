#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简易超时工具：
- 同步函数调用超时包装，超时抛出 AiTimeoutError（error_code=AI_TIMEOUT）
- 供各 pipeline 在调用模型推理时使用
"""

from __future__ import annotations

import concurrent.futures
from typing import Callable, TypeVar, Any

from logger import logger
from utils.errors import AiTimeoutError


T = TypeVar("T")


def run_with_timeout(func: Callable[..., T], timeout_seconds: float, *args: Any, **kwargs: Any) -> T:
    """
    在单独线程中执行同步函数，若在 timeout_seconds 内未完成，则抛出 AiTimeoutError。

    注意：
    - 仅适用于纯 Python 阻塞调用（如 ONNX 推理）；不适合需要强制杀死底层进程的场景
    - 超时后底层线程可能仍在执行，但结果会被丢弃
    """
    if timeout_seconds is None or timeout_seconds <= 0:
        return func(*args, **kwargs)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=timeout_seconds)
        except concurrent.futures.TimeoutError:
            logger.warning("run_with_timeout: 函数执行超时", details={"func": getattr(func, "__name__", str(func)), "timeout_seconds": timeout_seconds})
            raise AiTimeoutError()

