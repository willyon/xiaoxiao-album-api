#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI caption provider 占位实现。"""

from __future__ import annotations

from typing import Any, Dict

from providers.base import BaseCaptionProvider, provider_not_implemented_result


class OpenAICaptionProvider(BaseCaptionProvider):
    def analyze(
        self,
        image: Any,
        *,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
        cloud_api_key: str | None = None,
    ) -> Dict[str, Any]:
        return provider_not_implemented_result(
            capability="caption",
            provider="cloud:openai",
            data={
                "description": "",
                "keywords": [],
                "subject_tags": [],
                "action_tags": [],
                "scene_tags": [],
                "ocr": "",
            },
        )
