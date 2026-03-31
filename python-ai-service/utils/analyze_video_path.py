#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
/analyze_video 的 video_path：与图片相同的前缀白名单与大小校验，不读入整文件。
"""

from __future__ import annotations

from typing import Optional, Tuple

from utils.analyze_image_path import validate_analyze_path


def resolve_video_path_for_analyze(raw_path: Optional[str], *, max_bytes: int) -> Tuple[Optional[str], Optional[str]]:
    """
    仅校验路径与大小，不读入文件内容（供 OpenCV 等按路径打开）。
    max_bytes 由调用方传入（如 ANALYZE_VIDEO_MAX_FILE_BYTES）。
    返回 (realpath, None) 或 (None, error_message)。
    """
    return validate_analyze_path(raw_path, max_bytes)
