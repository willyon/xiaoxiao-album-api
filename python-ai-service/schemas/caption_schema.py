#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Caption 响应结构（独立接口 POST /analyze_caption）；正文仍用字段名 description。"""

from typing import List

from pydantic import BaseModel


class CaptionResponse(BaseModel):
    description: str = ""
    keywords: List[str] = []
    subject_tags: List[str] = []
    action_tags: List[str] = []
    scene_tags: List[str] = []
