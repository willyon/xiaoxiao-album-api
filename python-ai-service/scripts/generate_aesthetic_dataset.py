#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基于现有图库生成审美模型训练数据集。

流程：
1. 读取 SQLite `images` 表，筛选有高清图的记录。
2. 使用 NIMA 模型对高清图离线打分，得到 1-10 的审美分。
3. 调用 SigLIP2 图像编码器提取 768 维归一化 embedding。
4. 保存 `embeddings`、`scores`、`image_ids` 到 npz 文件，并输出 CSV 便于检查。

执行示例：
```
python3 scripts/generate_aesthetic_dataset.py --output-dir data/aesthetic_dataset
```
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple, TYPE_CHECKING

import numpy as np
from PIL import Image

import torch

try:  # pillow-heif 提供 AVIF/HEIC 支持
    from pillow_heif import register_heif_opener  # type: ignore
except ImportError:  # pragma: no cover
    register_heif_opener = None

from loaders.model_loader import get_nima_session, get_siglip2_components

if TYPE_CHECKING:  # pragma: no cover
    import pyiqa  # type: ignore[import-not-found]

from logger import logger
from services.cleanup_analysis_service import _prepare_siglip_pixel_values

# =======================
# 数据类定义
# =======================


@dataclass
class ImageRecord:
    image_id: int
    storage_key: str


@dataclass
class Sample:
    image_id: int
    storage_key: str
    score: float
    embedding: np.ndarray


# =======================
# 辅助函数
# =======================


def _enable_heif_support() -> None:
    if register_heif_opener is None:
        logger.warning(
            "pillow-heif 未安装，可能无法解码 AVIF/HEIC 图片。建议执行 `pip install pillow-heif`"
        )
        return
    try:
        register_heif_opener()
    except Exception as exc:  # pragma: no cover
        logger.warning("注册 HEIF/AVIF 解码器失败", details={"error": str(exc)})


def _open_rgb_image(full_path: Path) -> Optional[np.ndarray]:
    try:
        with Image.open(full_path) as image:
            rgb_image = image.convert("RGB")
            return np.array(rgb_image)
    except FileNotFoundError:
        logger.warning("图片文件不存在", details={"path": str(full_path)})
    except Exception as exc:  # pragma: no cover
        logger.error("读取图片失败", details={"path": str(full_path), "error": str(exc)})
    return None


def _infer_nima_score(session, rgb_image: np.ndarray) -> Optional[float]:
    try:
        image = Image.fromarray(rgb_image).resize((224, 224))
        image_array = np.asarray(image).astype(np.float32) / 255.0

        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        image_array = (image_array - mean) / std
        image_array = np.transpose(image_array, (2, 0, 1))
        image_array = np.expand_dims(image_array, axis=0)

        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: image_array})
        if not outputs:
            logger.error("NIMA 模型未返回输出")
            return None

        probabilities = np.squeeze(outputs[0])
        if probabilities.ndim != 1:
            logger.error("NIMA 输出维度异常", details={"shape": getattr(probabilities, "shape", None)})
            return None

        ratings = np.arange(1, probabilities.shape[0] + 1, dtype=np.float32)
        mean_score = float(np.sum(probabilities * ratings))
        return mean_score
    except Exception as exc:  # pragma: no cover
        logger.error("NIMA 推理失败", details={"error": str(exc)})
        return None


def _infer_pyiqa_score(metric, image_path: Path) -> Optional[float]:
    try:
        result = metric(str(image_path))
    except Exception as exc:  # pragma: no cover
        logger.error("pyiqa 推理失败", details={"path": str(image_path), "error": str(exc)})
        return None

    if isinstance(result, torch.Tensor):
        score = result.squeeze().cpu().item()
    elif isinstance(result, (list, tuple)):
        score = float(result[0])
    else:
        score = float(result)

    return score


def _infer_siglip_embedding(image_session, metadata, rgb_image: np.ndarray) -> Optional[np.ndarray]:
    pixel_values = _prepare_siglip_pixel_values(rgb_image, metadata)
    if pixel_values is None:
        return None

    try:
        input_name = image_session.get_inputs()[0].name
        outputs = image_session.run(None, {input_name: pixel_values})
        if not outputs:
            logger.error("SigLIP2 模型未返回输出")
            return None

        vector = outputs[0].astype(np.float32).reshape(-1)
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm
        return vector
    except Exception as exc:  # pragma: no cover
        logger.error("SigLIP2 推理失败", details={"error": str(exc)})
        return None


def _fetch_image_records(db_path: Path, limit: Optional[int] = None) -> List[ImageRecord]:
    connection = sqlite3.connect(str(db_path))
    try:
        connection.row_factory = sqlite3.Row
        cursor = connection.cursor()
        sql = """
            SELECT id, high_res_storage_key
            FROM images
            WHERE high_res_storage_key IS NOT NULL
            ORDER BY id
        """
        if limit is not None:
            sql += " LIMIT ?"
            cursor.execute(sql, (limit,))
        else:
            cursor.execute(sql)
        rows = cursor.fetchall()
        records = [ImageRecord(image_id=row["id"], storage_key=row["high_res_storage_key"]) for row in rows]
        return records
    finally:
        connection.close()


def _resolve_full_path(project_root: Path, storage_key: str) -> Path:
    return project_root / storage_key


def _ensure_output_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _save_npz(path: Path, samples: Sequence[Sample]) -> None:
    embeddings = np.stack([sample.embedding for sample in samples], axis=0).astype(np.float32)
    scores = np.array([sample.score for sample in samples], dtype=np.float32)
    image_ids = np.array([sample.image_id for sample in samples], dtype=np.int32)

    np.savez_compressed(
        path,
        embeddings=embeddings,
        scores=scores,
        image_ids=image_ids,
    )


def _save_csv(path: Path, samples: Sequence[Sample]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["image_id", "storage_key", "score"])
        for sample in samples:
            writer.writerow([sample.image_id, sample.storage_key, f"{sample.score:.4f}"])


# =======================
# 主执行逻辑
# =======================


def generate_dataset(
    *,
    project_root: Path,
    db_path: Path,
    output_dir: Path,
    limit: Optional[int] = None,
    score_source: str = "onnx",
    pyiqa_metric_name: str = "nima",
    pyiqa_device: str = "cpu",
    image_dir: Optional[Path] = None,
) -> Tuple[int, int]:
    logger.info(
        "开始生成审美训练数据集",
        details={
            "db_path": str(db_path),
            "output_dir": str(output_dir),
            "limit": limit,
            "score_source": score_source,
            "pyiqa_metric": pyiqa_metric_name if score_source == "pyiqa" else None,
            "pyiqa_device": pyiqa_device if score_source == "pyiqa" else None,
            "image_dir": str(image_dir) if image_dir else None,
        },
    )

    nima_session = None
    pyiqa_metric = None

    if score_source == "onnx":
        nima_session = get_nima_session()
        if nima_session is None:
            raise RuntimeError("NIMA 模型未找到，请将 nima_mobilenetv2.onnx 放置在 python-ai-service/models/ 目录下")
    else:
        try:
            import pyiqa  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("pyiqa 未安装，无法使用 pyiqa 评分模式") from exc

        try:
            pyiqa_metric = pyiqa.create_metric(pyiqa_metric_name, device=pyiqa_device or "cpu")
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                f"初始化 pyiqa 评分器失败: metric={pyiqa_metric_name}, device={pyiqa_device}"
            ) from exc

    image_session, _, _, metadata = get_siglip2_components()
    if image_session is None or metadata is None:
        raise RuntimeError("SigLIP2 模型未加载，请确认模型文件存在于 python-ai-service/models/siglip2/")

    if image_dir is not None:
        image_dir = image_dir.resolve()
        all_paths = sorted(
            [p for p in image_dir.iterdir() if p.is_file()]
        )
        if limit is not None:
            all_paths = all_paths[:limit]

        records: List[ImageRecord] = []
        for idx, path in enumerate(all_paths, start=1):
            try:
                storage_key = str(path.relative_to(project_root))
            except ValueError:
                storage_key = str(path)
            records.append(ImageRecord(image_id=idx, storage_key=storage_key))
    else:
        records = _fetch_image_records(db_path, limit)
    logger.info("共读取图片记录", details={"count": len(records)})

    _ensure_output_dir(output_dir)

    samples: List[Sample] = []
    skipped = 0
    project_root = project_root.resolve()

    for index, record in enumerate(records, start=1):
        full_path = _resolve_full_path(project_root, record.storage_key)
        rgb_image = _open_rgb_image(full_path)
        if rgb_image is None:
            skipped += 1
            continue

        if score_source == "onnx":
            score = _infer_nima_score(nima_session, rgb_image)
        else:
            score = _infer_pyiqa_score(pyiqa_metric, full_path)

        if score is None:
            skipped += 1
            continue

        embedding = _infer_siglip_embedding(image_session, metadata, rgb_image)
        if embedding is None:
            skipped += 1
            continue

        samples.append(Sample(
            image_id=record.image_id,
            storage_key=record.storage_key,
            score=score,
            embedding=embedding,
        ))

        if index % 50 == 0:
            logger.info(
                "处理中",
                details={
                    "processed": index,
                    "collected": len(samples),
                    "skipped": skipped,
                },
            )

    if not samples:
        raise RuntimeError("没有成功收集到训练样本，请检查模型与图片文件可用性")

    npz_path = output_dir / "dataset.npz"
    csv_path = output_dir / "scores.csv"

    _save_npz(npz_path, samples)
    _save_csv(csv_path, samples)

    logger.info(
        "数据集已生成",
        details={
            "npz": str(npz_path),
            "csv": str(csv_path),
            "sample_count": len(samples),
            "skipped": skipped,
        },
    )

    return len(samples), skipped


# =======================
# CLI 入口
# =======================


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成审美训练数据集")
    parser.add_argument(
        "--db-path",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "database.db",
        help="SQLite 数据库路径，默认使用项目根目录的 database.db",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "aesthetic_dataset",
        help="输出目录（将生成 dataset.npz 与 scores.csv）",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="可选：仅处理前 N 条记录用于调试",
    )
    parser.add_argument(
        "--score-source",
        choices=["onnx", "pyiqa"],
        default="onnx",
        help="美学分数来源：onnx（nima_mobilenetv2.onnx）或 pyiqa",
    )
    parser.add_argument(
        "--pyiqa-metric",
        type=str,
        default="nima",
        help="pyiqa 模型名称，默认使用 'nima'",
    )
    parser.add_argument(
        "--pyiqa-device",
        type=str,
        default="cpu",
        help="pyiqa 运行设备，默认 cpu，可设置为 cuda",
    )
    parser.add_argument(
        "--image-dir",
        type=Path,
        default=None,
        help="可选：直接遍历该目录下的图片生成数据集（忽略数据库）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = parse_args(argv)

    project_root = Path(__file__).resolve().parents[2]
    _enable_heif_support()

    try:
        collected, skipped = generate_dataset(
            project_root=project_root,
            db_path=args.db_path,
            output_dir=args.output_dir,
            limit=args.limit,
            score_source=args.score_source,
            pyiqa_metric_name=args.pyiqa_metric,
            pyiqa_device=args.pyiqa_device,
            image_dir=args.image_dir,
        )
        logger.info(
            "数据集生成完成",
            details={
                "collected": collected,
                "skipped": skipped,
            },
        )
    except Exception as exc:
        logger.error(
            "生成审美训练数据集失败",
            details={
                "error": str(exc),
            },
        )
        raise


if __name__ == "__main__":
    main()
