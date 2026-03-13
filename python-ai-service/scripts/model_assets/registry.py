from __future__ import annotations

from typing import Dict, Type

from .base import BaseModelAssetHandler
from .handlers.siglip2_handler import Siglip2Handler
from .handlers.yolo_handler import YoloHandler


HANDLER_REGISTRY: Dict[str, Type[BaseModelAssetHandler]] = {
    "siglip2": Siglip2Handler,
    "yolo": YoloHandler,
}


def get_handler(family: str) -> Type[BaseModelAssetHandler]:
    key = family.strip().lower()
    if key not in HANDLER_REGISTRY:
        raise ValueError(f"不支持的 family: {family}")
    return HANDLER_REGISTRY[key]

