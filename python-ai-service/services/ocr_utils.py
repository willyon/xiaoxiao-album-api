#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR blocks 规范化：无文字时上层应得到 blocks == []（或模块 status=empty），不把占位符当内容。
strip 后仍为空的块丢弃；合法的单字符「0」保留。
"""

from __future__ import annotations

from typing import Any, Dict, List


def normalize_ocr_blocks(blocks: Any) -> List[Dict[str, Any]]:
    """去掉 text 为空或仅空白的块；无有效块时返回 []。"""
    if not isinstance(blocks, list):
        return []
    out: List[Dict[str, Any]] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("text")
        if t is None:
            continue
        s = str(t).strip()
        if not s:
            continue
        nb = dict(b)
        nb["text"] = s
        out.append(nb)
    return out
