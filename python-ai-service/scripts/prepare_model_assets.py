#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

# 确保可以把 scripts 作为包导入：将项目根目录加入 sys.path
_THIS_FILE = Path(__file__).resolve()
_PROJECT_ROOT = _THIS_FILE.parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from scripts.model_assets.registry import get_handler  # type: ignore[import]
from scripts.model_assets.utils import log_done, log_error, log_info  # type: ignore[import]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="统一准备 Python AI 服务所需的模型资产",
    )

    parser.add_argument(
        "--family",
        required=True,
        help="模型家族，例如: siglip2 / yolo",
    )
    parser.add_argument(
        "--profile",
        help="模型规格或配置档位，例如: standard / enhanced（主要用于 siglip2）",
    )
    parser.add_argument(
        "--variant",
        help="模型变体，例如: yolo11x / yolo11m（主要用于 yolo）",
    )
    parser.add_argument(
        "--model-id",
        help="显式指定远端模型 ID（如 Hugging Face repo id），覆盖 handler 默认值",
    )
    parser.add_argument(
        "--output-dir",
        help="显式指定输出目录，默认由各 family handler 决定",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="允许覆盖已存在的输出文件",
    )
    parser.add_argument(
        "--skip-verify",
        action="store_true",
        help="跳过导出后的最小验证（仅调试使用，不推荐在线上环境开启）",
    )
    parser.add_argument(
        "--cpu-only",
        action="store_true",
        help="强制使用 CPU 导出（目前主要影响 siglip2 导出）",
    )

    return parser.parse_args()


def main(argv: list[str] | None = None) -> int:
    args = parse_args() if argv is None else parse_args()

    family = args.family.strip().lower()
    log_info(f"开始准备 family={family}")

    try:
        handler_cls = get_handler(family)
    except ValueError as exc:
        log_error(str(exc))
        return 1

    handler = handler_cls()

    try:
        result: Any = handler.prepare(args)
        log_done(f"family={family} 准备完成")
        if isinstance(result, int):
            return result
        return 0
    except KeyboardInterrupt:
        log_error("用户中断执行")
        return 130
    except Exception as exc:
        log_error(f"family={family} 准备失败: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

