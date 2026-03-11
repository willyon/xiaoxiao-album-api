#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 服务自定义异常
便于路由层统一转换为 4xx/5xx + { error_code, error_message }
"""

from __future__ import annotations

from typing import Optional


class AiServiceError(Exception):
    """AI 服务业务异常基类，可携带 error_code 供上层返回统一错误体。"""

    def __init__(
        self,
        message: str,
        error_code: Optional[str] = None,
    ):
        super().__init__(message)
        self.message = message
        self.error_code = error_code or "AI_SERVICE_ERROR"


class ImageDecodeError(AiServiceError):
    """图片解码失败（格式不支持、损坏等）。"""

    def __init__(self, message: str = "图片解码失败"):
        super().__init__(message, error_code="IMAGE_DECODE_FAILED")


class UnsupportedDeviceError(AiServiceError):
    """请求的设备不支持（如要求 cuda 但不可用）。"""

    def __init__(self, message: str = "请求的设备不支持"):
        super().__init__(message, error_code="AI_DEVICE_NOT_SUPPORTED")


class ModelMissingError(AiServiceError):
    """对应能力的模型未加载（能力关闭或加载失败）。"""

    def __init__(self, message: str, error_code: str = "AI_SERVICE_ERROR"):
        super().__init__(message, error_code=error_code)


class AiTimeoutError(AiServiceError):
    """单次推理超时。"""

    def __init__(self, message: str = "推理超时"):
        super().__init__(message, error_code="AI_TIMEOUT")
