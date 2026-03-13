from __future__ import annotations

import errno
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..base import BaseModelAssetHandler
from ..utils import (
    ensure_dir,
    get_project_root,
    is_overwrite_forbidden,
    log_error,
    log_info,
    verify_onnx_can_open,
    write_version_file,
)


class YoloHandler(BaseModelAssetHandler):
    family_name = "yolo"

    DEFAULT_VARIANT = "yolo11x"

    def prepare(self, args: Any) -> int:
        variant = (getattr(args, "variant", None) or self.DEFAULT_VARIANT).strip()
        output_dir = Path(self.resolve_output_dir(args))

        log_info(f"准备 YOLO 资产: variant={variant}")
        log_info(f"输出目录: {output_dir}")

        ensure_dir(output_dir)

        # 统一在进入临时目录之前就将目标路径解析为绝对路径，
        # 避免后续 chdir 到临时目录后出现相对路径指向错误目录的问题。
        target_onnx = (output_dir / f"{variant}.onnx").resolve()
        force: bool = bool(getattr(args, "force", False))
        skip_verify: bool = bool(getattr(args, "skip_verify", False))

        if is_overwrite_forbidden(target_onnx, force):
            log_error(f"检测到已有 {target_onnx}，且未指定 --force，拒绝覆盖")
            return 1

        try:
            from ultralytics import YOLO  # type: ignore[import]
        except Exception as exc:  # pragma: no cover - 环境依赖
            log_error(f"导入 ultralytics 失败，请确认已安装: {exc}")
            return 1

        model_name = variant
        log_info(f"加载 YOLO 模型: {model_name}.pt")
        model = YOLO(f"{model_name}.pt")

        # 为降低对全局工作目录和默认导出路径的依赖，这里在受控的临时目录中完成导出，
        # 然后再把结果原子性移动到 managed 目录。
        with tempfile.TemporaryDirectory(prefix="yolo_export_") as tmpdir:
            tmpdir_path = Path(tmpdir)
            prev_cwd = Path.cwd()
            try:
                os.chdir(tmpdir_path)
                log_info(f"开始在临时目录导出 YOLO ONNX: {tmpdir_path}")
                success = model.export(
                    format="onnx",
                    imgsz=640,
                    simplify=True,
                    opset=12,
                )
                if not success:
                    log_error("YOLO ONNX 导出失败")
                    return 1

                source_onnx = tmpdir_path / f"{model_name}.onnx"
                if not source_onnx.exists():
                    log_error(f"未找到导出的 ONNX 文件: {source_onnx}")
                    return 1

                ensure_dir(target_onnx.parent)
                try:
                    # 注意：某些 macOS 环境下，临时目录与项目目录可能位于不同卷上，
                    # 直接 os.replace 会触发 EXDEV（跨设备移动），此时退回到 copy+unlink。
                    source_onnx.replace(target_onnx)
                except OSError as exc:
                    if exc.errno == errno.EXDEV:
                        shutil.copy2(source_onnx, target_onnx)
                        source_onnx.unlink(missing_ok=True)
                    else:
                        raise
            finally:
                os.chdir(prev_cwd)

        log_info(f"ONNX 已保存到: {target_onnx}")

        # 写 version.txt
        version_data = {
            "model_id": variant,
            "family": self.family_name,
            "variant": variant,
            "runtime": "onnx",
            "script": "prepare_model_assets.py",
        }
        write_version_file(output_dir, version_data)

        if not skip_verify:
            self.verify(str(output_dir), args)

        return 0

    def resolve_output_dir(self, args: Any) -> str:  # type: ignore[override]
        explicit = getattr(args, "output_dir", None)
        if explicit:
            return str(Path(explicit))

        root = get_project_root()
        return str(root / "models" / "managed" / "object")

    def verify(self, output_dir: str, args: Any) -> None:  # type: ignore[override]
        variant = (getattr(args, "variant", None) or self.DEFAULT_VARIANT).strip()
        onnx_path = Path(output_dir) / f"{variant}.onnx"
        verify_onnx_can_open(onnx_path)

