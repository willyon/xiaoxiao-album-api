#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
设备解析工具
统一处理请求中的 device 参数：cpu / cuda / auto
与 Node 约定一致，供 pipeline 与路由使用
"""

from __future__ import annotations

from typing import Tuple

# 规范后的设备值
RESOLVED_CPU = "cpu"
RESOLVED_CUDA = "cuda"

# 合法输入
VALID_DEVICES = ("cpu", "cuda", "auto")


def cuda_available() -> bool:
    """检测当前环境是否可用 CUDA（供 /health 等使用）。"""
    return _cuda_available()


def _cuda_available() -> bool:
    """检测当前环境是否可用 CUDA（仅指 ONNX 等实际会用到的能力）。"""
    try:
        import onnxruntime as ort
        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def normalize_device(device: str) -> Tuple[str, str | None]:
    """
    将请求中的 device 规范为合法值，并做简单校验。
    
    - cpu   → 强制 CPU
    - cuda  → 要求 GPU，若不可用则返回错误码，供上层返回 AI_DEVICE_NOT_SUPPORTED
    - auto  → CUDA 可用用 GPU，否则 CPU；模型 GPU 加载失败时可 fallback CPU
    - 非法值 → 返回 (非法值, "AI_DEVICE_NOT_SUPPORTED") 供上层返回 400
    
    Args:
        device: 原始字符串，可为 None/空（视为 "auto"）
    
    Returns:
        (normalized_device, error_code)
        - normalized_device: "cpu" | "cuda"
        - error_code: None 表示合法；非 None 表示应返回的错误码（如 AI_DEVICE_NOT_SUPPORTED）
    """
    if not device or not isinstance(device, str):
        raw = "auto"
    else:
        raw = device.strip().lower()
    
    if raw not in VALID_DEVICES:
        return (raw, "AI_DEVICE_NOT_SUPPORTED")
    
    if raw == "cpu":
        return (RESOLVED_CPU, None)
    
    if raw == "cuda":
        if _cuda_available():
            return (RESOLVED_CUDA, None)
        return (RESOLVED_CUDA, "AI_DEVICE_NOT_SUPPORTED")
    
    # auto
    if _cuda_available():
        return (RESOLVED_CUDA, None)
    return (RESOLVED_CPU, None)


def resolve_device(device: str) -> str:
    """
    解析设备并返回实际使用的设备字符串。
    
    - 合法输入：返回 "cpu" 或 "cuda"
    - 非法输入（例如 "mps"）或 cuda 不可用：一律回落到 "cpu"，避免下游出现 KeyError("mps") 之类错误。
    """
    resolved, err = normalize_device(device)
    if err:
        # 包括两类：
        # - 请求 cuda 但当前环境不支持
        # - 传入了未在 VALID_DEVICES 中的字符串（如 "mps"）
        return RESOLVED_CPU
    return resolved
