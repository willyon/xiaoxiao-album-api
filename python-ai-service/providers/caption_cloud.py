#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云 caption provider 分发层。"""

from __future__ import annotations

from typing import Any, Dict

from config import normalize_cloud_vendor, settings
from providers.base import BaseCaptionProvider, provider_not_implemented_result
from providers.caption_openai import OpenAICaptionProvider
from providers.caption_qwen import QwenCaptionProvider


class CloudCaptionProvider(BaseCaptionProvider):
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
        configured_vendor = getattr(settings, "CAPTION_CLOUD_VENDOR", "qwen")
        resolved_vendor = normalize_cloud_vendor(configured_vendor)
        provider = {
            "qwen": QwenCaptionProvider(),
            "openai": OpenAICaptionProvider(),
        }.get(resolved_vendor)
        if provider is not None:
            return provider.analyze(
                image,
                profile=profile,
                device=device,
                model_manager=model_manager,
                configured_provider=configured_provider,
                resolved_provider=resolved_provider,
            )
        return provider_not_implemented_result(
            capability="caption",
            provider=f"{resolved_provider}:{resolved_vendor}",
            data={"description": "", "keywords": [], "subject_tags": [], "action_tags": [], "scene_tags": []},
            meta={
                "configured_provider": configured_provider,
                "resolved_provider": resolved_provider,
                "configured_vendor": configured_vendor,
                "resolved_vendor": resolved_vendor,
                "model": getattr(settings, "CAPTION_CLOUD_MODEL", "") or "",
            },
        )
