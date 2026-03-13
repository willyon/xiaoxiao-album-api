from __future__ import annotations

import datetime as _dt
import os
from pathlib import Path
from typing import Dict

import onnxruntime as ort


def get_project_root() -> Path:
    """返回 python-ai-service 的项目根目录。

    通过向上查找锚点文件/目录来定位，而不是依赖“向上几级”的相对位置，
    这样当 scripts 目录结构调整时，根目录解析依然稳定。
    """
    anchor_files = {"requirements.txt", "app.py", "start.py", "README.md"}
    anchor_dirs = {"scripts", "services", "routes"}

    current = Path(__file__).resolve()
    for parent in [current] + list(current.parents):
        if not parent.is_dir():
            continue

        entries = {p.name for p in parent.iterdir()}
        if (entries & anchor_files) and (entries & anchor_dirs):
            return parent

    # 回退策略：如果没找到锚点，至少退到原有的 parents[2] 行为，
    # 避免直接抛异常导致调用方全挂。
    return Path(__file__).resolve().parents[2]


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _log(prefix: str, msg: str) -> None:
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{prefix}] {now} {msg}")


def log_info(msg: str) -> None:
    _log("INFO", msg)


def log_done(msg: str) -> None:
    _log("DONE", msg)


def log_error(msg: str) -> None:
    _log("ERROR", msg)


def log_verify(msg: str) -> None:
    _log("VERIFY", msg)


def log_suggest(msg: str) -> None:
    _log("SUGGEST", msg)


def write_version_file(output_dir: Path, data: Dict[str, str]) -> None:
    """写 version.txt，格式为 key=value 每行一项。"""
    ensure_dir(output_dir)
    lines = [f"{k}={v}" for k, v in sorted(data.items())]
    (output_dir / "version.txt").write_text("\n".join(lines), encoding="utf-8")


def verify_onnx_can_open(path: Path) -> None:
    """使用 onnxruntime 尝试打开 onnx 文件，确保不是空壳。"""
    if not path.exists():
        raise FileNotFoundError(f"ONNX 文件不存在: {path}")
    if path.stat().st_size <= 0:
        raise RuntimeError(f"ONNX 文件大小异常: {path}")

    log_verify(f"尝试使用 onnxruntime 打开: {path}")
    _ = ort.InferenceSession(path.as_posix(), providers=["CPUExecutionProvider"])


def resolve_default_models_dir() -> Path:
    """返回默认的 models 根目录（项目根下的 models/）。"""
    root = get_project_root()
    return root / "models"


def is_overwrite_forbidden(target: Path, force: bool) -> bool:
    """判断是否因为未开启 force 而禁止覆盖已有文件。"""
    return target.exists() and not force


def env_bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "y", "on"}

