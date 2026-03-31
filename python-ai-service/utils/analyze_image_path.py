#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
/analyze_image 的 image_path 入参：规范化、前缀白名单、读入字节。
与 multipart 二选一；与 Node 本地存储传递的绝对路径对齐。

与视频共用的路径校验逻辑见 validate_analyze_path；视频侧封装在 utils.analyze_video_path。
"""

from __future__ import annotations

import os
from typing import Optional, Tuple

from config import settings


def validate_analyze_path(raw_path: Optional[str], max_bytes: int) -> Tuple[Optional[str], Optional[str]]:
    """
    共享：规范化路径、白名单、存在性、大小上限（图片读字节与视频按路径打开前共用）。
    成功返回 (realpath, None)，失败返回 (None, error_message)。
    """
    if not raw_path or not str(raw_path).strip():
        return None, "路径为空"

    normalized = os.path.normpath(str(raw_path).strip())
    try:
        real = os.path.realpath(normalized)
    except OSError as e:
        return None, f"路径无效: {e}"

    allow = getattr(settings, "ANALYZE_IMAGE_PATH_ALLOW_PREFIX", "") or ""
    allow = str(allow).strip()
    if allow:
        try:
            allow_real = os.path.realpath(os.path.normpath(allow))
        except OSError as e:
            return None, f"ANALYZE_IMAGE_PATH_ALLOW_PREFIX 无效: {e}"
        sep = os.sep
        if real != allow_real and not real.startswith(allow_real + sep):
            return None, "路径不在允许目录内"

    if not os.path.isfile(real):
        return None, "文件不存在或不是普通文件"

    try:
        size = os.path.getsize(real)
    except OSError as e:
        return None, f"无法读取文件信息: {e}"
    if size > max_bytes:
        return None, f"文件超过大小上限 ({max_bytes} bytes)"

    return real, None


def read_image_bytes_from_path(raw_path: Optional[str]) -> Tuple[Optional[bytes], Optional[str]]:
    """
    校验路径并读取文件字节（图片分析用，大小上限 ANALYZE_IMAGE_MAX_FILE_BYTES）。
    返回 (bytes, None) 或 (None, error_message)。
    """
    max_bytes = int(getattr(settings, "ANALYZE_IMAGE_MAX_FILE_BYTES", 1024 * 1024 * 1024))
    real, err = validate_analyze_path(raw_path, max_bytes)
    if err or not real:
        return None, err

    try:
        with open(real, "rb") as f:
            data = f.read()
    except OSError as e:
        return None, f"读取文件失败: {e}"

    if not data:
        return None, "图片数据为空"

    return data, None
