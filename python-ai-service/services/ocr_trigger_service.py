#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""smart OCR 触发信号收集与判定。"""

from __future__ import annotations

from typing import Any, Dict

import cv2
import numpy as np
from config import settings
from services.ocr_text_hints import TEXT_HINT_WORDS


def collect_ocr_trigger_signals(
    image_bgr: np.ndarray,
    *,
    caption_module: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """收集 smart OCR 的触发信号，用于留痕与判定。"""
    return {
        "has_dense_text_like_regions": _has_dense_text_like_regions(image_bgr),
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

    # smart 模式下优先以“文字信号”为准，避免仅因截图/长图特征触发 OCR 云调用。
    has_text_signal = bool(signals.get("has_dense_text_like_regions")) or bool(signals.get("caption_hint_text_related"))
    if has_text_signal:
        return True

    return False


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

        threshold = int(getattr(settings, "OCR_SMART_TEXT_LIKE_COUNT_THRESHOLD", 18) or 18)
        threshold = max(8, threshold)
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
                if text_like_count >= threshold:
                    return True
        return False
    except Exception:
        return False


def _caption_hint_text_related(caption_module: Dict[str, Any] | None) -> bool:
    if not isinstance(caption_module, dict):
        return False
    data = caption_module.get("data") or {}
    parts = [str(data.get("description") or "").strip()]
    keywords = data.get("keywords") or []
    if isinstance(keywords, list):
        parts.extend(str(x).strip() for x in keywords if str(x).strip())
    haystack = " ".join(parts).strip()
    if not haystack:
        return False
    haystack_lower = haystack.lower()
    return any(word in haystack_lower for word in TEXT_HINT_WORDS)
