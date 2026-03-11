#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Caption 响应结构"""

from typing import List

from pydantic import BaseModel


class CaptionResponse(BaseModel):
    caption: str = ""
    keywords: List[str] = []
