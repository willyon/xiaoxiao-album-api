#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景分类响应结构"""

from typing import List, Optional

from pydantic import BaseModel


class SceneResponse(BaseModel):
    primary_scene: Optional[str] = None
    scene_tags: List[str] = []
    confidence: float = 0.0
