from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from ..base import BaseModelAssetHandler
from ..utils import (
    ensure_dir,
    get_project_root,
    log_error,
    log_info,
    log_suggest,
    verify_onnx_can_open,
    write_version_file,
)
from scripts.export_siglip2_to_onnx import export_siglip2


class Siglip2Handler(BaseModelAssetHandler):
    family_name = "siglip2"

    # 第一版先把默认 model_id 写死在常量里，后续可以抽到配置
    DEFAULT_MODELS: Dict[str, str] = {
        "standard": "google/siglip2-base-patch16-224",
        "enhanced": "google/siglip2-so400m-patch14-384",
    }

    def prepare(self, args: Any) -> int:
        profile = (args.profile or "standard").strip().lower()
        model_id = (args.model_id or self.DEFAULT_MODELS.get(profile) or self.DEFAULT_MODELS["standard"]).strip()

        output_dir = Path(self.resolve_output_dir(args, profile=profile))
        force: bool = bool(getattr(args, "force", False))
        skip_verify: bool = bool(getattr(args, "skip_verify", False))
        cpu_only: bool = bool(getattr(args, "cpu_only", False))

        log_info(f"准备 SigLIP2 资产: profile={profile}, model_id={model_id}")
        log_info(f"输出目录: {output_dir}")

        ensure_dir(output_dir)

        image_onnx = output_dir / "siglip2_image_encoder.onnx"
        text_onnx = output_dir / "siglip2_text_encoder.onnx"

        if not force and (image_onnx.exists() or text_onnx.exists()):
            log_error("检测到已有 SigLIP2 ONNX 文件，且未指定 --force，拒绝覆盖")
            return 1

        # 调用现有导出逻辑
        export_siglip2(
            model_id=model_id,
            output_dir=output_dir,
            force_cpu=cpu_only,
        )

        # 写 version.txt
        version_data = {
            "model_id": model_id,
            "family": self.family_name,
            "profile": profile,
            "runtime": "onnx",
            "script": "prepare_model_assets.py",
        }
        write_version_file(output_dir, version_data)

        if not skip_verify:
            self.verify(str(output_dir), args)

        if profile == "enhanced":
            # 目前 enhanced 仍存在导出不稳定的可能，给出回退建议
            log_suggest("如遇 SigLIP2 enhanced 导出问题，可暂时回退到 profile=standard")

        return 0

    def resolve_output_dir(self, args: Any, *, profile: str | None = None) -> str:  # type: ignore[override]
        explicit = getattr(args, "output_dir", None)
        if explicit:
            return str(Path(explicit))

        profile = (profile or args.profile or "standard").strip().lower()
        root = get_project_root()
        return str(root / "models" / "managed" / "siglip2" / profile)

    def verify(self, output_dir: str, args: Any) -> None:  # type: ignore[override]
        out = Path(output_dir)
        image_onnx = out / "siglip2_image_encoder.onnx"
        text_onnx = out / "siglip2_text_encoder.onnx"

        verify_onnx_can_open(image_onnx)
        verify_onnx_can_open(text_onnx)

