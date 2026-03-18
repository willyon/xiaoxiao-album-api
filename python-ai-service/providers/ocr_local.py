#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 OCR provider。"""

from __future__ import annotations

from typing import Any, Dict

from pipelines.ocr_pipeline import analyze_ocr_detailed
from providers.base import BaseOcrProvider


class LocalOcrProvider(BaseOcrProvider):
    def recognize(
        self,
        image: Any,
        *,
        profile: str,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
        trigger_mode: str,
        trigger_signals: Dict[str, Any],
    ) -> Dict[str, Any]:
        result = analyze_ocr_detailed(
            image,
            profile,
            device,
            model_manager,
            resolved_provider=resolved_provider,
            configured_provider=configured_provider,
            trigger_mode=trigger_mode,
            trigger_signals=trigger_signals,
        )
        result.setdefault("meta", {})
        result["meta"]["configured_provider"] = configured_provider
        result["meta"]["resolved_provider"] = resolved_provider
        return result
