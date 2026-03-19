"""路由包聚合模块

这里只导入当前实际存在且在 `app.py` 中使用的路由模块，避免因为
误写/残留的模块名导致 ImportError 或“部分初始化的 routes 包”问题。
"""

from . import (
    analyze_full,
    caption,
    quality,
    face_cluster,
    health,
    ocr,
    person,
)

__all__ = [
    "analyze_full",
    "caption",
    "quality",
    "face_cluster",
    "health",
    "ocr",
    "person",
]
