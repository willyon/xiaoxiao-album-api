#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云 OCR provider 分发层。"""

from __future__ import annotations

from typing import Any, Dict

from config import normalize_cloud_vendor, settings
from providers.base import BaseOcrProvider, provider_not_implemented_result
from providers.ocr_openai import OpenAIOcrProvider
from providers.ocr_qwen import QwenOcrProvider


class CloudOcrProvider(BaseOcrProvider):
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
        configured_vendor = getattr(settings, "OCR_CLOUD_VENDOR", "qwen")
        resolved_vendor = normalize_cloud_vendor(configured_vendor)
        provider = {
            "qwen": QwenOcrProvider(),
            "openai": OpenAIOcrProvider(),
        }.get(resolved_vendor)
        if provider is not None:
            return provider.recognize(
                image,
                profile=profile,
                device=device,
                model_manager=model_manager,
                configured_provider=configured_provider,
                resolved_provider=resolved_provider,
                trigger_mode=trigger_mode,
                trigger_signals=trigger_signals,
            )
        return provider_not_implemented_result(
            capability="ocr",
            provider=f"{resolved_provider}:{resolved_vendor}",
            data={"blocks": []},
            meta={
                "configured_provider": configured_provider,
                "resolved_provider": resolved_provider,
                "configured_vendor": configured_vendor,
                "resolved_vendor": resolved_vendor,
                "model": getattr(settings, "OCR_CLOUD_MODEL", "") or "",
                "trigger_mode": trigger_mode,
                "trigger_signals": trigger_signals,
            },
        )
