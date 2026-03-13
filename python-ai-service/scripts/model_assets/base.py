from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseModelAssetHandler(ABC):
    """模型资产准备 handler 基类。"""

    #: handler 对应的 family 名称，例如 "siglip2" / "yolo"
    family_name: str = ""

    @abstractmethod
    def prepare(self, args: Any) -> int:
        """主执行入口。

        返回值:
            0 表示成功，非 0 表示失败。
        """

    @abstractmethod
    def resolve_output_dir(self, args: Any) -> str:
        """根据参数决定输出目录路径。"""

    def verify(self, output_dir: str, args: Any) -> None:
        """导出后最小验证。

        第一版可以是空实现，具体 family 视需要覆盖。
        """
        return None

