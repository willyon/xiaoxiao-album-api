#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图像 caption provider 工厂。"""

from providers.caption_cloud import CloudCaptionProvider
from providers.caption_local import LocalCaptionProvider


def get_caption_provider(resolved_provider: str):
    if resolved_provider == "local":
        return LocalCaptionProvider()
    if resolved_provider == "cloud":
        return CloudCaptionProvider()
    return None
