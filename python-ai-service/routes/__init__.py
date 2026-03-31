"""路由包聚合模块

仅包含 `app.py` 中实际挂载的路由模块。
"""

from . import (
    analyze_image,
    analyze_video,
    face_cluster,
    health,
)

__all__ = [
    "analyze_image",
    "analyze_video",
    "face_cluster",
    "health",
]
