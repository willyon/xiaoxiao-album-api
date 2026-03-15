#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图片质量分析服务（原 cleanup 能力）
------------------------------------
负责生成媒体质量相关指标，供智能清理/筛选使用：
- 感知哈希：用于重复图/相似图的初筛
- 清晰度指标：用于模糊图筛查
- 美学评分：用于推荐保留图片
- 通用视觉向量：来自 siglip_embedding_service，用于相似度检索与审美头输入

设计要点：
- 统一使用 decode_image（含 EXIF 校正）
- 模型懒加载，避免重复初始化
- 输出统一转换为 Python 原生类型，便于 JSON 序列化
"""

from __future__ import annotations

import numpy as np
import cv2
from typing import Dict, Optional
import torch
from logger import logger
import time
from utils.image_decode import decode_image
from loaders.model_loader import get_aesthetic_head_session
from services.siglip_embedding_service import compute_siglip_embedding


def analyze_image_from_bytes(
    image_bytes: bytes,
    profile: str = "standard",
) -> Dict[str, object]:
    """
    路由层入口：从上传的原始字节解析图片并生成清理指标。
    - 输入：原始图片字节（任意常见格式）
    - 输出：见 analyze_image 的返回结构（不含 embedding，图像向量由 /encode_image 提供）
    """
    t0 = time.perf_counter()
    image_bgr, error = decode_image(image_bytes)
    if error or image_bgr is None:
        raise ValueError(error or "图片解码失败")
    try:
        result = analyze_image(image_bgr, profile=profile)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info("quality.decode_and_analyze.ok", details={"elapsed_ms": elapsed_ms})
        return result
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.error("quality.decode_and_analyze.fail", details={"elapsed_ms": elapsed_ms, "error": str(exc)})
        raise


def analyze_image(
    image_bgr: np.ndarray,
    profile: str = "standard",
) -> Dict[str, object]:
    """
    针对 OpenCV BGR 图片生成清理指标。
    返回字段：hashes、aesthetic_score、sharpness_score（不含 embedding，图像向量由 /encode_image 提供）。
    内部仍计算 SigLIP 向量用于 aesthetic_score，但不返回。
    """
    if image_bgr is None or not isinstance(image_bgr, np.ndarray):
        raise ValueError("无效的图片数据")

    t0 = time.perf_counter()
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    rgb_image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    t_prep = int((time.perf_counter() - t0) * 1000)
    logger.info("quality.stage.preprocess", details={"elapsed_ms": t_prep})

    t2 = time.perf_counter()
    embedding_payload = compute_siglip_embedding(rgb_image, profile=profile)
    t_embed = int((time.perf_counter() - t2) * 1000)
    logger.info(
        "quality.stage.embedding",
        details={"elapsed_ms": t_embed, "has_vector": bool(embedding_payload and embedding_payload.get("vector"))},
    )
    embedding_vector = np.asarray(embedding_payload["vector"], dtype=np.float32) if embedding_payload and embedding_payload.get("vector") else None

    t3 = time.perf_counter()
    aesthetic_score = _compute_aesthetic_score(embedding_vector)
    t_aes = int((time.perf_counter() - t3) * 1000)
    logger.info("quality.stage.aesthetic", details={"elapsed_ms": t_aes, "aesthetic_score": aesthetic_score})

    t4 = time.perf_counter()
    sharpness_metrics = _compute_sharpness_metrics(gray)
    sharpness_score = float(sharpness_metrics["score"])
    t_sharpness = int((time.perf_counter() - t4) * 1000)
    logger.info("quality.stage.sharpness", details={"elapsed_ms": t_sharpness, "sharpness_score": sharpness_score})

    payload = {
        "hashes": _compute_hashes(gray),
        "aesthetic_score": aesthetic_score,
        "sharpness_score": sharpness_score,
    }
    total_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "quality.stage.hashes_and_summary",
        details={
            "elapsed_ms": total_ms,
            "has_hashes": True,
            "aesthetic_score": aesthetic_score,
            "sharpness_score": sharpness_score,
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
# 清晰度指标（优化版：多指标融合 + 边缘区域检测）
# ===========================

def _compute_sharpness_metrics(gray_image: np.ndarray) -> Dict[str, float]:
    """
    计算清晰度分数（行业主流多指标融合算法）。
    
    算法流程：
    1. 预处理：resize + 轻微高斯去噪（减少噪声干扰）
    2. 边缘区域检测：使用 Canny 边缘检测，只计算边缘区域的清晰度（更准确）
    3. 多指标计算：
       - Laplacian variance（拉普拉斯方差，二阶导数）
       - Tenengrad（Sobel 梯度平方均值，一阶导数）
       - Brenner gradient（Brenner 梯度，相邻像素差分）
       - SMD（Sum of Modified Differences，改进差分和）
    4. 自适应归一化：使用对数归一化处理大动态范围
    5. 加权融合：根据指标稳定性分配权重
    
    参考：
    - Laplacian variance: Pech-Pacheco et al. (2000)
    - Tenengrad: Krotkov (1987)
    - Brenner gradient: Brenner et al. (1976)
    - SMD: 改进的差分方法，对噪声更鲁棒
    """
    # Step 1: 预处理 - resize 到标准尺寸（512px 短边）
    # 优化：当图片短边小于512时，不放大（避免放大低分辨率图片导致计算不准确）
    h, w = gray_image.shape[:2]
    target_short = 512
    short = min(h, w)
    
    if short > 0 and short > target_short:
        # 只缩小，不放大（短边 > 512 时才 resize）
        scale = target_short / short
        new_w = int(round(w * scale))
        new_h = int(round(h * scale))
        gray_resized = cv2.resize(gray_image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    else:
        # 短边 <= 512，保持原尺寸（不放大）
        gray_resized = gray_image
    
    # Step 1.5: 轻微高斯去噪（减少噪声对清晰度检测的干扰）
    # 使用小核（3x3）和低sigma（0.5），只去除高频噪声，保留边缘信息
    gray_denoised = cv2.GaussianBlur(gray_resized, (3, 3), 0.5)
    
    # Step 2: 边缘区域检测（只计算边缘区域的清晰度，更准确）
    # 使用 Canny 边缘检测，创建边缘掩码
    edges = cv2.Canny(gray_denoised, 50, 150)
    edge_mask = edges > 0
    
    # 如果边缘像素太少（<5%），可能是纯色图或低对比度图，使用全图计算
    edge_ratio = np.sum(edge_mask) / edge_mask.size
    if edge_ratio < 0.05:
        edge_mask = np.ones_like(edge_mask, dtype=bool)
    
    # Step 3: 计算多种清晰度指标
    
    # 3.1 Laplacian variance（拉普拉斯方差，二阶导数）
    # 优点：对模糊敏感，计算快速
    laplacian = cv2.Laplacian(gray_denoised, cv2.CV_64F)
    laplacian_var = float(np.var(laplacian[edge_mask])) if np.any(edge_mask) else float(np.var(laplacian))
    
    # 3.2 Tenengrad（Sobel 梯度平方均值，一阶导数）
    # 优点：对边缘敏感，鲁棒性好
    sobel_x = cv2.Sobel(gray_denoised, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray_denoised, cv2.CV_64F, 0, 1, ksize=3)
    gradient_magnitude = np.sqrt(sobel_x ** 2 + sobel_y ** 2)
    tenengrad = float(np.mean(gradient_magnitude[edge_mask] ** 2)) if np.any(edge_mask) else float(np.mean(gradient_magnitude ** 2))
    
    # 3.3 Brenner gradient（Brenner 梯度，相邻像素差分）
    # 优点：计算简单，对运动模糊敏感
    diff_x = np.diff(gray_denoised.astype(np.float64), axis=1)
    diff_y = np.diff(gray_denoised.astype(np.float64), axis=0)
    brenner_x = float(np.mean(diff_x ** 2))
    brenner_y = float(np.mean(diff_y ** 2))
    brenner = (brenner_x + brenner_y) / 2.0
    
    # 3.4 SMD（Sum of Modified Differences，改进差分和）
    # 优点：对噪声更鲁棒，适合低对比度图像
    # 计算水平和垂直方向的改进差分
    h, w = gray_denoised.shape
    smd_h = np.sum(np.abs(np.diff(gray_denoised.astype(np.float64), axis=1))) / (h * (w - 1))
    smd_v = np.sum(np.abs(np.diff(gray_denoised.astype(np.float64), axis=0))) / ((h - 1) * w)
    smd = float((smd_h + smd_v) / 2.0)
    
    # Step 4: 自适应归一化（使用对数归一化处理大动态范围）
    # 使用经验阈值范围（基于512px resize后的统计）
    def log_normalize(value, lower, upper):
        """对数归一化，处理大动态范围"""
        if value <= lower:
            return 0.0
        if value >= upper:
            return 1.0
        # 使用对数尺度归一化
        log_value = np.log1p(value - lower)
        log_range = np.log1p(upper - lower)
        return float(log_value / log_range)
    
    # 归一化各指标（使用对数归一化）
    laplacian_norm = log_normalize(laplacian_var, lower=10.0, upper=1000.0)
    tenengrad_norm = log_normalize(tenengrad, lower=20.0, upper=2000.0)
    brenner_norm = log_normalize(brenner, lower=5.0, upper=500.0)
    smd_norm = log_normalize(smd, lower=1.0, upper=50.0)
    
    # Step 5: 加权融合（根据指标稳定性和重要性分配权重）
    # Laplacian: 40% (最稳定，对模糊最敏感)
    # Tenengrad: 30% (鲁棒性好，对边缘敏感)
    # Brenner: 20% (对运动模糊敏感)
    # SMD: 10% (对噪声鲁棒，适合低对比度图)
    score = (
        0.40 * laplacian_norm +
        0.30 * tenengrad_norm +
        0.20 * brenner_norm +
        0.10 * smd_norm
    )
    score = float(np.clip(score, 0.0, 1.0))
    
    return {
        "score": score,
        "laplacian_var": laplacian_var,
        "tenengrad": tenengrad,
        "brenner": brenner,
        "smd": smd,
        "laplacian_norm": laplacian_norm,
        "tenengrad_norm": tenengrad_norm,
        "brenner_norm": brenner_norm,
        "smd_norm": smd_norm,
        "edge_ratio": float(edge_ratio),
    }


# ===========================
# 美学评分（仅使用 SigLIP + 小头）
# ===========================

def _compute_aesthetic_score(embedding_vector: np.ndarray) -> float:
    """
    使用 SigLIP 向量 + 审美回归头推理得到 0~100 分，并归一化到 0~1。
    
    Args:
        embedding_vector: SigLIP 向量（1152 维），已计算好的向量，避免重复计算
    
    Returns:
        美学分数（0~1）
    """
    head_session = get_aesthetic_head_session()
    if not head_session:
        raise RuntimeError("Aesthetic Head 未加载，无法生成美学分数")
    
    if embedding_vector is None or embedding_vector.size == 0:
        raise RuntimeError("SigLIP 向量为空")
    if embedding_vector.size != 1152:
        raise RuntimeError(
            "审美头要求 1152 维 SigLIP 向量，当前为 %s 维，请检查图像编码器输出是否选用了正确的 embedding 输出"
            % embedding_vector.size
        )
    vec = np.asarray(embedding_vector, dtype=np.float32).reshape(1, -1)
    input_name = head_session.get_inputs()[0].name
    out = head_session.run(None, {input_name: vec})
    if not out:
        raise RuntimeError("Aesthetic Head 无输出")
    score_0_100 = float(np.squeeze(out[0]))
    return float(np.clip(score_0_100 / 100.0, 0.0, 1.0))

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

