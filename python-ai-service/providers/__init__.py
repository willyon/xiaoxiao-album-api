#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Caption / OCR provider 工厂。"""

from providers.caption_cloud import CloudCaptionProvider
from providers.caption_local import LocalCaptionProvider
from providers.ocr_cloud import CloudOcrProvider
from providers.ocr_local import LocalOcrProvider


def get_caption_provider(resolved_provider: str):
    if resolved_provider == "local":
        return LocalCaptionProvider()
    if resolved_provider == "cloud":
        return CloudCaptionProvider()
    return None


def get_ocr_provider(resolved_provider: str):
    if resolved_provider == "local":
        return LocalOcrProvider()
    if resolved_provider == "cloud":
        return CloudOcrProvider()
    return None
