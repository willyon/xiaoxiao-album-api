#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Provider 基础抽象。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

from constants.error_codes import AI_SERVICE_ERROR
from services.module_result import MODULE_STATUS_FAILED, build_module_result


class BaseCaptionProvider(ABC):
    @abstractmethod
    def analyze(
        self,
        image: Any,
        *,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
    ) -> Dict[str, Any]:
        raise NotImplementedError


def provider_not_implemented_result(
    *,
    capability: str,
    provider: str,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return build_module_result(
        status=MODULE_STATUS_FAILED,
        data=data or {},
        error={"code": AI_SERVICE_ERROR, "message": f"{capability} provider not implemented: {provider}"},
    )
