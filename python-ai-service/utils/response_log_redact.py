#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
供 POST /analyze_image 等接口在写响应日志时使用：递归去掉 embedding / 高维向量，避免控制台被数千维浮点撑爆。
不影响实际返回给 Node 的 JSON。
"""

from __future__ import annotations

from typing import Any


def _is_long_numeric_vector(v: Any, *, min_len: int) -> bool:
    if not isinstance(v, (list, tuple)) or len(v) < min_len:
        return False
    try:
        float(v[0])
        return True
    except (TypeError, ValueError, IndexError):
        return False


def redact_embeddings_for_log(obj: Any, *, min_vector_len: int = 32) -> Any:
    """
    递归复制结构，将以下占位替换：
    - 键名为 vector 且为长数值序列（默认 >=32 维，用于 SigLIP 等）
    - 其余字段（如 embedding.status / embedding.duration_ms）保留，便于排查耗时
    """
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            # 统一约定：所有高维向量都放在 vector 字段中
            if k == "vector" and _is_long_numeric_vector(v, min_len=min_vector_len):
                out[k] = "<redacted len=%d>" % len(v)
            else:
                out[k] = redact_embeddings_for_log(v, min_vector_len=min_vector_len)
        return out
    if isinstance(obj, list):
        return [redact_embeddings_for_log(i, min_vector_len=min_vector_len) for i in obj]
    if isinstance(obj, tuple):
        return tuple(redact_embeddings_for_log(i, min_vector_len=min_vector_len) for i in obj)
    return obj


