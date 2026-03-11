#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""物体检测响应结构"""

from typing import List

from pydantic import BaseModel


class ObjectItem(BaseModel):
    label: str
    confidence: float
    bbox: List[float]  # [x1, y1, x2, y2]


class ObjectResponse(BaseModel):
    objects: List[ObjectItem] = []
