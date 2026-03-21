#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
请求级日志上下文：供各推理接口在 request.state 上设置字段，由中间件统一打一行结构化日志。
文档约定：endpoint, profile, requested_device, resolved_device, model_name, latency_ms, result_count, error_code
"""

from typing import Any, Optional


def get_image_size(img: Any) -> Optional[str]:
    """从 PIL Image 或 ndarray 得到 'width x height'，供日志使用。"""
    if img is None:
        return None
    try:
        if hasattr(img, "size"):
            return f"{img.size[0]}x{img.size[1]}"
        if hasattr(img, "shape") and len(img.shape) >= 2:
            return f"{img.shape[1]}x{img.shape[0]}"
    except Exception:
        pass
    return None


def set_request_log_context(
    request: Any,
    *,
    profile: Optional[str] = None,
    requested_device: Optional[str] = None,
    resolved_device: Optional[str] = None,
    model_name: Optional[str] = None,
    result_count: Optional[int] = None,
    error_code: Optional[str] = None,
    image_size: Optional[str] = None,
    configured_provider: Optional[str] = None,
    resolved_provider: Optional[str] = None,
    configured_vendor: Optional[str] = None,
    resolved_vendor: Optional[str] = None,
    ocr_trigger_mode: Optional[str] = None,
    ocr_triggered: Optional[bool] = None,
    ocr_signal_has_dense_text_like_regions: Optional[bool] = None,
    ocr_signal_caption_hint_text_related: Optional[bool] = None,
    caption_status: Optional[str] = None,
    ocr_status: Optional[str] = None,
    top_status: Optional[str] = None,
) -> None:
    """
    在 request.state 上设置本次请求的日志上下文，供中间件在响应后统一输出。
    各路由在成功路径和异常路径（在 raise 前）调用，传入已有参数。
    """
    if not hasattr(request, "state"):
        return
    if profile is not None:
        request.state._log_profile = profile
    if requested_device is not None:
        request.state._log_requested_device = requested_device
    if resolved_device is not None:
        request.state._log_resolved_device = resolved_device
    if model_name is not None:
        request.state._log_model_name = model_name
    if result_count is not None:
        request.state._log_result_count = result_count
    if error_code is not None:
        request.state._log_error_code = error_code
    if image_size is not None:
        request.state._log_image_size = image_size
    if configured_provider is not None:
        request.state._log_configured_provider = configured_provider
    if resolved_provider is not None:
        request.state._log_resolved_provider = resolved_provider
    if configured_vendor is not None:
        request.state._log_configured_vendor = configured_vendor
    if resolved_vendor is not None:
        request.state._log_resolved_vendor = resolved_vendor
    if ocr_trigger_mode is not None:
        request.state._log_ocr_trigger_mode = ocr_trigger_mode
    if ocr_triggered is not None:
        request.state._log_ocr_triggered = ocr_triggered
    if ocr_signal_has_dense_text_like_regions is not None:
        request.state._log_ocr_signal_has_dense_text_like_regions = ocr_signal_has_dense_text_like_regions
    if ocr_signal_caption_hint_text_related is not None:
        request.state._log_ocr_signal_caption_hint_text_related = ocr_signal_caption_hint_text_related
    if caption_status is not None:
        request.state._log_caption_status = caption_status
    if ocr_status is not None:
        request.state._log_ocr_status = ocr_status
    if top_status is not None:
        request.state._log_top_status = top_status
