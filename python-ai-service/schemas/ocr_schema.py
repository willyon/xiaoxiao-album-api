#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OCR 响应结构"""

from typing import List

from pydantic import BaseModel


class OcrBlock(BaseModel):
    text: str
    bbox: List[float]  # [x1, y1, x2, y2]
    confidence: float


class OcrResponse(BaseModel):
    blocks: List[OcrBlock] = []
