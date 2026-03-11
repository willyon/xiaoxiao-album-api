#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
场景分类用 canonical prompt 词表
供 SigLIP2 zero-shot scene classification 使用，与 Node taxonomy 约定一致
"""

# 首版约 14 个典型场景（英文 Raw Label，Node 侧可映射为 Canonical + 中文）
SCENE_LABELS = [
    "indoor",
    "outdoor",
    "home",
    "office",
    "street",
    "beach",
    "mountain",
    "forest",
    "restaurant",
    "city",
    "nature",
    "portrait",
    "food",
    "vehicle",
]
