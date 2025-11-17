#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片清理分析服务
--------------------------------
负责生成智能清理所需的基础指标：
- 感知哈希：用于重复图/相似图的初筛
- 清晰度指标：用于模糊图筛查
- 美学评分：用于推荐保留图片
- 通用视觉向量：用于相似度检索

设计要点：
- 复用现有的 decode 工具（convert_to_opencv）
- 模型懒加载，避免重复初始化
- 输出统一转换为 Python 原生类型，便于 JSON 序列化
- 留出模型替换空间，后续可升级算法
"""

from __future__ import annotations

import numpy as np
import cv2
from typing import Dict, Optional
import torch
from PIL import Image

from logger import logger
import time
from utils.images import convert_to_opencv
from loaders.model_loader import get_siglip2_components, get_aesthetic_head_session


def analyze_image_from_bytes(image_bytes: bytes) -> Dict[str, object]:
    """
    路由层入口：从上传的原始字节解析图片并生成清理指标。
    - 输入：原始图片字节（任意常见格式）
    - 输出：见 analyze_image 的返回结构
    """
    t0 = time.perf_counter()
    image_bgr, error = convert_to_opencv(image_bytes)
    if error:
        raise ValueError(error)
    try:
        result = analyze_image(image_bgr)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info("cleanup.decode_and_analyze.ok", details={"elapsed_ms": elapsed_ms})
        return result
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.error("cleanup.decode_and_analyze.fail", details={"elapsed_ms": elapsed_ms, "error": str(exc)})
        raise


def analyze_image(image_bgr: np.ndarray) -> Dict[str, object]:
    """
    针对 OpenCV BGR 图片生成清理指标。
    返回字段：
      - perceptual_hash: 主哈希（phash）
      - hashes: 包含 phash 与 dhash
      - sharpness_score: 清晰度综合分（0~1，汇总指标）
      - aesthetic_score: 审美分（0~1，SigLIP 向量经审美回归头推理）
      - embedding: SigLIP 图像向量及元信息（见 _compute_siglip_embedding）
    """
    if image_bgr is None or not isinstance(image_bgr, np.ndarray):
        raise ValueError("无效的图片数据")

    t0 = time.perf_counter()
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    rgb_image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    t_prep = int((time.perf_counter() - t0) * 1000)
    logger.info("cleanup.stage.preprocess", details={"elapsed_ms": t_prep})

    t1 = time.perf_counter()
    sharpness = _compute_sharpness_metrics(gray)
    t_sharp = int((time.perf_counter() - t1) * 1000)
    logger.info("cleanup.stage.sharpness", details={"elapsed_ms": t_sharp, "sharpness_score": sharpness.get("score")})

    t2 = time.perf_counter()
    embedding_payload = _compute_siglip_embedding(rgb_image)
    t_embed = int((time.perf_counter() - t2) * 1000)
    logger.info(
        "cleanup.stage.embedding",
        details={"elapsed_ms": t_embed, "has_vector": bool(embedding_payload and embedding_payload.get("vector"))},
    )

    # 使用已计算的向量，避免重复计算 SigLIP embedding
    embedding_vector = np.asarray(embedding_payload["vector"], dtype=np.float32) if embedding_payload and embedding_payload.get("vector") else None
    
    t3 = time.perf_counter()
    aesthetic_score = _compute_aesthetic_score(embedding_vector, sharpness["score"])
    t_aes = int((time.perf_counter() - t3) * 1000)
    logger.info("cleanup.stage.aesthetic", details={"elapsed_ms": t_aes, "aesthetic_score": aesthetic_score})

    payload = {
        "hashes": _compute_hashes(gray),
        "sharpness_score": sharpness["score"],
        "aesthetic_score": aesthetic_score,
        "embedding": embedding_payload,
    }
    total_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "cleanup.stage.hashes_and_summary",
        details={
            "elapsed_ms": total_ms,
            "has_hashes": True,
            "sharpness_score": sharpness.get("score"),
            "aesthetic_score": aesthetic_score,
        },
    )
    return _convert_to_native_types(payload)


# ===========================
# 感知哈希
# ===========================

def _compute_hashes(gray_image: np.ndarray) -> Dict[str, str]:
    """计算感知哈希（phash + dhash），用于相似/重复图筛查。"""
    return {"phash": _phash(gray_image), "dhash": _dhash(gray_image)}


def _phash(gray_image: np.ndarray, hash_size: int = 8, highfreq_factor: int = 4) -> str:
    """pHash：基于 DCT 的感知哈希，尺寸默认 8x8。"""
    if gray_image.ndim != 2:
        gray_image = cv2.cvtColor(gray_image, cv2.COLOR_BGR2GRAY)

    img_size = hash_size * highfreq_factor
    resized = cv2.resize(gray_image, (img_size, img_size), interpolation=cv2.INTER_LINEAR)
    resized = np.float32(resized)

    dct = cv2.dct(resized)
    dct_low = dct[:hash_size, :hash_size]
    median = np.median(dct_low)
    diff = dct_low > median

    return _binary_array_to_hex(diff.flatten())


def _dhash(gray_image: np.ndarray, hash_size: int = 8) -> str:
    """dHash：基于相邻像素差分的哈希，尺寸默认 8。"""
    if gray_image.ndim != 2:
        gray_image = cv2.cvtColor(gray_image, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray_image, (hash_size + 1, hash_size), interpolation=cv2.INTER_LINEAR)
    diff = resized[:, 1:] > resized[:, :-1]
    return _binary_array_to_hex(diff.flatten())


def _binary_array_to_hex(binary_array: np.ndarray) -> str:
    bits = "".join("1" if bit else "0" for bit in binary_array)
    return f"{int(bits, 2):0{len(bits) // 4}x}"


# ===========================
# 清晰度指标
# ===========================

def _compute_sharpness_metrics(gray_image: np.ndarray) -> Dict[str, float]:
    """计算清晰度相关指标：拉普拉斯方差、Tenengrad，并归一化汇总为 score。"""
    laplacian_var = float(cv2.Laplacian(gray_image, cv2.CV_64F).var())

    sobel_x = cv2.Sobel(gray_image, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray_image, cv2.CV_64F, 0, 1, ksize=3)
    gradient_magnitude = np.sqrt(sobel_x ** 2 + sobel_y ** 2)
    tenengrad = float(np.mean(gradient_magnitude ** 2))

    laplacian_norm = _normalize_metric(laplacian_var, lower=30.0, upper=900.0)
    tenengrad_norm = _normalize_metric(tenengrad, lower=50.0, upper=1200.0)

    score = 0.7 * laplacian_norm + 0.3 * tenengrad_norm
    score = float(np.clip(score, 0.0, 1.0))

    # 仅返回最终 score（中间量不再对外暴露）
    return {"score": score}


def _normalize_metric(value: float, *, lower: float, upper: float) -> float:
    if upper <= lower:
        return 0.0
    normalized = (value - lower) / (upper - lower)
    return float(np.clip(normalized, 0.0, 1.0))


# ===========================
# 美学评分（仅使用 SigLIP + 小头）
# ===========================

def _compute_aesthetic_score(embedding_vector: np.ndarray, sharpness_score: float) -> float:
    """
    使用 SigLIP 向量 + 审美回归头推理得到 0~100 分，并归一化到 0~1。
    
    Args:
        embedding_vector: SigLIP 向量（1152 维），已计算好的向量，避免重复计算
        sharpness_score: 清晰度分数（0~1），为后续可能的多模态加权预留，当前实现未参与计算
    
    Returns:
        美学分数（0~1）
    """
    head_session = get_aesthetic_head_session()
    if not head_session:
        raise RuntimeError("Aesthetic Head 未加载，无法生成美学分数")
    
    if embedding_vector is None or embedding_vector.size == 0:
        raise RuntimeError("SigLIP 向量为空")
    
    vec = np.asarray(embedding_vector, dtype=np.float32).reshape(1, -1)
    input_name = head_session.get_inputs()[0].name
    out = head_session.run(None, {input_name: vec})
    if not out:
        raise RuntimeError("Aesthetic Head 无输出")
    score_0_100 = float(np.squeeze(out[0]))
    return float(np.clip(score_0_100 / 100.0, 0.0, 1.0))

# ===========================
# SigLIP2 向量
# ===========================


def _compute_siglip_embedding(rgb_image: np.ndarray) -> Optional[Dict[str, object]]:
    """计算 SigLIP 图像向量，返回向量及维度/模型信息等元数据。"""
    image_session, _, _, metadata = get_siglip2_components()
    if image_session is None or metadata is None:
        return None

    pixel_values = _prepare_siglip_pixel_values(rgb_image, metadata)
    if pixel_values is None:
        return None

    input_name = image_session.get_inputs()[0].name
    outputs = image_session.run(None, {input_name: pixel_values})
    if not outputs:
        return None

    vector = outputs[0].astype(np.float32).flatten()
    norm = np.linalg.norm(vector)
    if norm > 0:
        vector = vector / norm

    # 入库建议：仅存 vector 及 model_id/analysis_version；dimension 恒定可不存
    return {"vector": vector.tolist(), "model": metadata.get("model_id", "siglip2")}


def _prepare_siglip_pixel_values(rgb_image: np.ndarray, metadata: Dict[str, object]) -> Optional[np.ndarray]:
    """按 metadata.json 要求执行 resize/center-crop/归一化，返回 ONNX 输入张量。"""
    try:
        image = Image.fromarray(rgb_image)
    except Exception as exc:  # pragma: no cover
        logger.error("SigLIP2 预处理失败：无法构建 PIL 图像", details={"error": str(exc)})
        return None

    resample = _resolve_resample(metadata.get("resample"))
    size_cfg = metadata.get("size") or {}
    crop_cfg = metadata.get("crop_size") or {}

    if metadata.get("do_resize", True) and isinstance(size_cfg, dict):
        if "shortest_edge" in size_cfg:
            target = int(size_cfg["shortest_edge"])
            image = _resize_to_shorter_edge(image, target, resample=resample)
        elif "height" in size_cfg and "width" in size_cfg:
            target_size = (int(size_cfg["width"]), int(size_cfg["height"]))
            image = image.resize(target_size, resample=resample)

    if metadata.get("do_center_crop", True) and isinstance(crop_cfg, dict):
        target_height = int(crop_cfg.get("height", crop_cfg.get("shortest_edge", image.height)))
        target_width = int(crop_cfg.get("width", crop_cfg.get("shortest_edge", image.width)))
        image = _center_crop(image, target_height, target_width)

    image_array = np.asarray(image).astype(np.float32) / 255.0
    mean = np.array(metadata.get("image_mean", [0.5, 0.5, 0.5]), dtype=np.float32)
    std = np.array(metadata.get("image_std", [0.5, 0.5, 0.5]), dtype=np.float32)
    image_array = (image_array - mean) / std
    image_array = np.transpose(image_array, (2, 0, 1))
    return np.expand_dims(image_array.astype(np.float32), axis=0)


def _resolve_resample(value) -> int:
    if value is None:
        return Image.BICUBIC
    try:
        return int(value)
    except Exception:  # pragma: no cover
        return Image.BICUBIC


def _resize_to_shorter_edge(image: Image.Image, target: int, *, resample: int) -> Image.Image:
    width, height = image.size
    if min(width, height) == target:
        return image

    if width < height:
        new_width = target
        new_height = int(round(height * target / width))
    else:
        new_height = target
        new_width = int(round(width * target / height))
    return image.resize((new_width, new_height), resample=resample)


def _center_crop(image: Image.Image, target_height: int, target_width: int) -> Image.Image:
    width, height = image.size
    left = max(0, int(round((width - target_width) / 2)))
    top = max(0, int(round((height - target_height) / 2)))
    right = left + target_width
    bottom = top + target_height
    return image.crop((left, top, right, bottom))
# ===========================
# 工具
# ===========================

def _convert_to_native_types(obj):
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return [_convert_to_native_types(item) for item in obj.tolist()]
    if isinstance(obj, torch.Tensor):
        return _convert_to_native_types(obj.cpu().numpy())
    if isinstance(obj, dict):
        return {key: _convert_to_native_types(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_convert_to_native_types(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_convert_to_native_types(item) for item in obj)
    if isinstance(obj, (float, int, str)) or obj is None:
        return obj
    return str(obj)


__all__ = ["analyze_image_from_bytes", "analyze_image"]

