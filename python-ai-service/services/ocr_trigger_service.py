#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""smart OCR 触发信号收集与判定。"""

from __future__ import annotations

from typing import Any, Dict

import cv2
import numpy as np


TEXT_HINT_WORDS = (
    "截图",
    "文字",
    "界面",
    "聊天",
    "海报",
    "菜单",
    "文档",
    "表格",
    "屏幕",
    "网页",
)


def collect_ocr_trigger_signals(
    image_bgr: np.ndarray,
    *,
    force_ocr: bool = False,
    caption_module: Dict[str, Any] | None = None,
    provider_policy_requires_ocr: bool = False,
) -> Dict[str, Any]:
    """收集 smart OCR 的触发信号，用于留痕与判定。"""
    return {
        "is_screenshot": _is_screenshot_like(image_bgr),
        "is_long_image": _is_long_image(image_bgr),
        "has_dense_text_like_regions": _has_dense_text_like_regions(image_bgr),
        "user_force_ocr": bool(force_ocr),
        "provider_policy_requires_ocr": bool(provider_policy_requires_ocr),
        "caption_hint_text_related": _caption_hint_text_related(caption_module),
    }


def should_run_ocr(trigger_mode: str, trigger_signals: Dict[str, Any] | None) -> bool:
    """根据 trigger_mode 和信号决定是否执行 OCR。"""
    mode = (trigger_mode or "always").strip().lower()
    signals = trigger_signals if isinstance(trigger_signals, dict) else {}
    if mode == "off":
        return False
    if mode == "always":
        return True
    if mode != "smart":
        return True

    strong_keys = (
        "is_screenshot",
        "is_long_image",
        "has_dense_text_like_regions",
        "user_force_ocr",
        "provider_policy_requires_ocr",
    )
    return any(bool(signals.get(key)) for key in strong_keys)


def _is_long_image(image_bgr: np.ndarray) -> bool:
    if image_bgr is None or not isinstance(image_bgr, np.ndarray) or image_bgr.ndim < 2:
        return False
    h, w = image_bgr.shape[:2]
    short_edge = max(1, min(h, w))
    long_edge = max(h, w)
    return long_edge >= 1400 and (long_edge / short_edge) >= 2.2


def _is_screenshot_like(image_bgr: np.ndarray) -> bool:
    if image_bgr is None or not isinstance(image_bgr, np.ndarray) or image_bgr.ndim < 2:
        return False
    h, w = image_bgr.shape[:2]
    if h <= 0 or w <= 0:
        return False
    ratio = w / float(h)
    portrait_like = h >= 1200 and 0.45 <= ratio <= 0.65
    landscape_like = w >= 1200 and 1.45 <= ratio <= 2.25
    return portrait_like or landscape_like


def _has_dense_text_like_regions(image_bgr: np.ndarray) -> bool:
    if image_bgr is None or not isinstance(image_bgr, np.ndarray) or image_bgr.ndim < 2:
        return False
    try:
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        long_edge = max(h, w)
        if long_edge > 1280:
            scale = 1280.0 / float(long_edge)
            gray = cv2.resize(gray, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))))

        binary = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            25,
            15,
        )
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
        contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

        text_like_count = 0
        for cnt in contours:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area = cw * ch
            if area < 20 or area > 3000:
                continue
            if cw < 8 or ch < 6 or ch > 80:
                continue
            aspect = cw / float(max(ch, 1))
            if 1.0 <= aspect <= 20.0:
                text_like_count += 1
                if text_like_count >= 25:
                    return True
        return False
    except Exception:
        return False


def _caption_hint_text_related(caption_module: Dict[str, Any] | None) -> bool:
    if not isinstance(caption_module, dict):
        return False
    data = caption_module.get("data") or {}
    parts = [str(data.get("caption") or "").strip()]
    keywords = data.get("keywords") or []
    if isinstance(keywords, list):
        parts.extend(str(x).strip() for x in keywords if str(x).strip())
    haystack = " ".join(parts)
    return any(word in haystack for word in TEXT_HINT_WORDS if haystack)
