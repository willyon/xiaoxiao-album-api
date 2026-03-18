#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI caption provider 占位实现。"""

from __future__ import annotations

from typing import Any, Dict

from config import settings
from providers.base import BaseCaptionProvider, provider_not_implemented_result


class OpenAICaptionProvider(BaseCaptionProvider):
    def analyze(
        self,
        image: Any,
        *,
        profile: str,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
    ) -> Dict[str, Any]:
        return provider_not_implemented_result(
            capability="caption",
            provider="cloud:openai",
            data={"caption": "", "keywords": []},
            meta={
                "configured_provider": configured_provider,
                "resolved_provider": resolved_provider,
                "configured_vendor": getattr(settings, "CAPTION_CLOUD_VENDOR", "qwen"),
                "resolved_vendor": "openai",
                "model": getattr(settings, "CAPTION_CLOUD_MODEL", "") or "",
                "base_url": getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "",
            },
        )
