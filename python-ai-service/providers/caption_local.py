#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 caption provider。"""

from __future__ import annotations

from typing import Any, Dict

from pipelines.caption_pipeline import analyze_caption_detailed
from providers.base import BaseCaptionProvider


class LocalCaptionProvider(BaseCaptionProvider):
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
        result = analyze_caption_detailed(
            image,
            profile,
            device,
            model_manager,
            resolved_provider=resolved_provider,
        )
        result.setdefault("meta", {})
        result["meta"]["configured_provider"] = configured_provider
        result["meta"]["resolved_provider"] = resolved_provider
        return result
