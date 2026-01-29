#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文本向量化服务
使用 SigLIP2 文本编码器将文本转换为 1152 维向量
"""

from __future__ import annotations

import numpy as np
from typing import Optional, Dict, List

from logger import logger
from loaders.model_loader import get_siglip2_components


def encode_text(text: str) -> Optional[Dict[str, object]]:
    """
    使用 SigLIP2 文本编码器将文本转换为 1152 维向量
    
    Args:
        text: 输入文本字符串
        
    Returns:
        包含向量和模型信息的字典，格式：{"vector": [float], "model": "siglip2"}
        如果编码失败则返回 None
    """
    if not text or not text.strip():
        return None
    
    try:
        # 获取 SigLIP2 组件
        _, text_session, tokenizer, metadata = get_siglip2_components()
        
        if text_session is None or tokenizer is None or metadata is None:
            logger.error("SigLIP2 文本编码器组件未加载")
            return None
        
        # 从 ONNX 模型读取 input_ids 的期望形状，避免维度不匹配（如 Got: 77 Expected: 4）
        max_length = _get_input_ids_seq_length(text_session)
        
        # 准备文本输入
        input_ids, attention_mask = _prepare_text_inputs(text, tokenizer, metadata, max_length=max_length)
        
        if input_ids is None or attention_mask is None:
            logger.error("文本预处理失败")
            return None
        
        # 获取 ONNX 模型的输入名称
        input_names = [inp.name for inp in text_session.get_inputs()]
        
        # 构建输入字典
        inputs = {}
        if "input_ids" in input_names:
            inputs["input_ids"] = input_ids
        if "attention_mask" in input_names:
            inputs["attention_mask"] = attention_mask
        
        # 运行 ONNX 模型
        outputs = text_session.run(None, inputs)
        
        if not outputs or len(outputs) == 0:
            logger.error("文本编码器无输出")
            return None
        
        # 提取向量（第一个输出）
        vector = outputs[0].astype(np.float32)
        
        # 如果输出是 [batch_size, 1152]，取第一个（batch_size=1）
        if len(vector.shape) > 1:
            vector = vector[0]
        
        vector = vector.flatten()
        
        # L2 归一化（与图像向量保持一致）
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm
        
        return {
            "vector": vector.tolist(),
            "model": metadata.get("model_id", "siglip2")
        }
        
    except Exception as exc:
        logger.error("文本编码失败", details={"error": str(exc), "text": text[:50]})
        return None


def _get_input_ids_seq_length(text_session) -> int:
    """
    从 ONNX 文本编码器读取 input_ids 的序列长度（第二维）。
    若模型期望 (batch, 4) 则返回 4，避免 INVALID_ARGUMENT: Got 77 Expected 4。
    """
    default = 77
    for inp in text_session.get_inputs():
        if inp.name != "input_ids":
            continue
        try:
            shape = inp.shape
            if len(shape) >= 2 and shape[1] is not None:
                n = int(shape[1])
                if n > 0:
                    return n
        except (TypeError, ValueError, IndexError):
            pass
        break
    return default


def _prepare_text_inputs(text: str, tokenizer, metadata: Dict[str, object], max_length: Optional[int] = None) -> tuple:
    """
    准备文本编码器的输入：input_ids 和 attention_mask
    
    Args:
        text: 输入文本
        tokenizer: SentencePiece tokenizer
        metadata: SigLIP2 元数据配置
        max_length: 序列长度，若为 None 则从 metadata 或默认 77 读取
        
    Returns:
        (input_ids, attention_mask) 元组，失败时返回 (None, None)
    """
    try:
        if max_length is None:
            max_length = int(metadata.get("max_length", 77))
        max_length = max(1, int(max_length))
        
        # 从 metadata 中获取特殊 token IDs
        pad_token_id = metadata.get("pad_token_id", 0)
        eos_token_id = metadata.get("eos_token_id", 1)
        add_eos_token = True  # SigLIP2 通常需要 EOS token
        
        # 使用 tokenizer 编码文本
        # SentencePiece 的 EncodeAsIds 方法返回 token IDs 列表
        token_ids = tokenizer.EncodeAsIds(text)
        
        # 添加 EOS token（如果配置要求）
        if add_eos_token and eos_token_id is not None:
            token_ids.append(eos_token_id)
        
        # 截断或填充到 max_length
        if len(token_ids) > max_length:
            token_ids = token_ids[:max_length]
            # 确保最后一个 token 是 EOS（如果原本有）
            if add_eos_token and eos_token_id is not None:
                token_ids[-1] = eos_token_id
        
        # 创建 attention_mask（1 表示有效 token，0 表示 padding）
        attention_mask = [1] * len(token_ids)
        
        # 右侧填充到 max_length
        padding_length = max_length - len(token_ids)
        if padding_length > 0:
            token_ids.extend([pad_token_id] * padding_length)
            attention_mask.extend([0] * padding_length)
        
        # 转换为 numpy 数组，并添加 batch 维度
        input_ids_array = np.array([token_ids], dtype=np.int64)
        attention_mask_array = np.array([attention_mask], dtype=np.int64)
        
        return input_ids_array, attention_mask_array
        
    except Exception as exc:
        logger.error("文本预处理失败", details={"error": str(exc), "text": text[:50]})
        return None, None
