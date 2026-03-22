from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..base import BaseModelAssetHandler
from ..utils import (
    ensure_dir,
    get_project_root,
    log_error,
    log_info,
    verify_onnx_can_open,
    write_version_file,
)


def _ensure_siglip2_tokenizer_and_metadata(
    model_id: str, output_dir: Path, *, force_refresh: bool = False
) -> None:
    """
    从 HuggingFace 拉取 tokenizer.model 并写入 metadata.json，供运行时 loader 使用。
    SigLIP2 ONNX 导出脚本只产出 image/text encoder，不包含 tokenizer，此处补全。

    force_refresh: 为 True 时即使文件已存在也重新下载/写入（用于 --force 时的完整版本更新）。
    """
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        log_error("未安装 huggingface_hub，无法下载 tokenizer。请 pip install huggingface_hub 后重试。")
        raise

    tokenizer_path = output_dir / "tokenizer.model"
    if force_refresh or not tokenizer_path.exists():
        log_info(f"从 HuggingFace 下载 tokenizer.model: {model_id}" + (" (强制刷新)" if force_refresh else ""))
        hf_hub_download(
            repo_id=model_id,
            filename="tokenizer.model",
            local_dir=str(output_dir),
            local_dir_use_symlinks=False,
        )
    else:
        log_info("已有 tokenizer.model，跳过下载")

    metadata_path = output_dir / "metadata.json"
    if force_refresh or not metadata_path.exists():
        metadata = {
            "model_id": model_id,
            "max_length": 64,
            "pad_token_id": 0,
            "eos_token_id": 1,
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        log_info(f"已写入 {metadata_path.name}" + (" (强制刷新)" if force_refresh else ""))


class Siglip2Handler(BaseModelAssetHandler):
    family_name = "siglip2"

    # 与运行时 models/managed/siglip2 及注册表项 embedding.standard.siglip2.base 一致（model_id 为稳定标识符）
    DEFAULT_MODEL_ID = "google/siglip2-so400m-patch14-384"

    def prepare(self, args: Any) -> int:
        model_id = (args.model_id or self.DEFAULT_MODEL_ID).strip()

        output_dir = Path(self.resolve_output_dir(args))
        force: bool = bool(getattr(args, "force", False))
        skip_verify: bool = bool(getattr(args, "skip_verify", False))
        cpu_only: bool = bool(getattr(args, "cpu_only", False))

        log_info(f"准备 SigLIP2 资产: model_id={model_id}")
        log_info(f"输出目录: {output_dir}")

        ensure_dir(output_dir)

        image_onnx = output_dir / "siglip2_image_encoder.onnx"
        text_onnx = output_dir / "siglip2_text_encoder.onnx"

        need_export = force or not (image_onnx.exists() and text_onnx.exists())
        if need_export:
            # 调用现有导出逻辑（仅产出 image/text encoder ONNX）；按需导入避免无导出脚本时补全失败
            from scripts.export_siglip2_to_onnx import export_siglip2

            export_siglip2(
                model_id=model_id,
                output_dir=output_dir,
                force_cpu=cpu_only,
            )
        else:
            log_info("ONNX 已存在，跳过导出；仅补全 tokenizer/metadata（若有缺失）")

        # 补全 tokenizer.model 与 metadata.json；--force 时一并刷新以保持版本一致
        _ensure_siglip2_tokenizer_and_metadata(model_id, output_dir, force_refresh=need_export)

        # 写 version.txt（每次运行都更新 updated_at，便于区分“上次准备时间”）
        version_data = {
            "model_id": model_id,
            "family": self.family_name,
            "runtime": "onnx",
            "script": "prepare_model_assets.py",
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        write_version_file(output_dir, version_data)

        if not skip_verify:
            self.verify(str(output_dir), args)

        return 0

    def resolve_output_dir(self, args: Any) -> str:
        explicit = getattr(args, "output_dir", None)
        if explicit:
            return str(Path(explicit))

        root = get_project_root()
        return str(root / "models" / "managed" / "siglip2")

    def verify(self, output_dir: str, args: Any) -> None:  # type: ignore[override]
        out = Path(output_dir)
        image_onnx = out / "siglip2_image_encoder.onnx"
        text_onnx = out / "siglip2_text_encoder.onnx"
        tokenizer_file = out / "tokenizer.model"
        metadata_file = out / "metadata.json"

        verify_onnx_can_open(image_onnx)
        verify_onnx_can_open(text_onnx)
        if not tokenizer_file.exists():
            log_error(f"缺少 tokenizer.model，运行时将无法使用文本向量化。路径: {tokenizer_file}")
        if not metadata_file.exists():
            log_error(f"缺少 metadata.json，运行时将无法使用文本向量化。路径: {metadata_file}")

