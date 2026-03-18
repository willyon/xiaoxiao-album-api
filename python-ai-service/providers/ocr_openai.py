#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI OCR provider 占位实现。"""

from __future__ import annotations

from typing import Any, Dict

from config import settings
from providers.base import BaseOcrProvider, provider_not_implemented_result


class OpenAIOcrProvider(BaseOcrProvider):
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
        return provider_not_implemented_result(
            capability="ocr",
            provider="cloud:openai",
            data={"blocks": []},
            meta={
                "configured_provider": configured_provider,
                "resolved_provider": resolved_provider,
                "configured_vendor": getattr(settings, "OCR_CLOUD_VENDOR", "qwen"),
                "resolved_vendor": "openai",
                "model": getattr(settings, "OCR_CLOUD_MODEL", "") or "",
                "base_url": getattr(settings, "OCR_CLOUD_BASE_URL", "") or "",
                "trigger_mode": trigger_mode,
                "trigger_signals": trigger_signals,
            },
        )
