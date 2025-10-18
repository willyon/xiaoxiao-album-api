#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
表情分析器 - 基于 EmotiEffLib ONNX
提供8类表情识别（使用ONNX后端，避免PyTorch 2.6+兼容性问题）
"""

import cv2
import numpy as np
from logger import logger
from config import settings
from loaders.face_loader import get_expression_model


class ExpressionAnalyzer:
    """表情分析器 - 基于EmotiEffLib ONNX（避免PyTorch兼容性问题）"""
    
    def __init__(self):
        """初始化表情分析器
        
        功能说明：
        从统一的 model_loader 获取预加载的 EmotiEffLib ONNX 模型
        
        优点：
        - 模型由 loader 统一管理，避免重复加载
        - 服务启动时已经加载好，无冷启动延迟
        """
        try:
            # 从 loader 获取已加载的模型
            self.model = get_expression_model()
            logger.info('✅ EmotiEffLib ONNX表情分析器初始化完成')
            
        except Exception as e:
            logger.error(f'EmotiEffLib初始化失败: {e}', exc_info=True)
            self.model = None
    
    def analyze(self, image, faces):
        """
        分析图像中所有人脸的表情
        
        Args:
            image: OpenCV图像 (BGR格式)
            faces: 检测到的人脸列表，每个元素包含bbox信息
            
        Returns:
            list: 表情分析结果列表，与 faces 列表一一对应
                  失败或低质量人脸返回默认的 neutral 表情
        """
        if not self.model or not faces:
            return []
        
        results = []
        
        # 注意：传入的faces都是高质量人脸（已在detector中过滤）
        for face in faces:
            try:
                result = self._analyze_single_face(image, face)
                # 确保总是添加结果，即使分析失败也返回默认值
                if result:
                    results.append(result)
                else:
                    # 分析失败，返回默认的 neutral 表情
                    results.append({
                        'value': 'neutral',
                        'confidence': 0.0
                    })
            except Exception as e:
                logger.error(f'单个人脸表情分析失败: {e}')
                # 异常时也要添加默认值，保持列表长度一致
                results.append({
                    'value': 'neutral',
                    'confidence': 0.0
                })
        
        return results
    
    def _analyze_single_face(self, image, face):
        """
        分析单个人脸的表情
        
        Args:
            image: OpenCV图像 (BGR格式)
            face: 人脸信息，包含bbox
            
        Returns:
            dict: 表情分析结果
        """
        try:
            # 1. 提取人脸区域
            bbox = face.get('bbox', [])
            if len(bbox) != 4:
                return None
            
            x1, y1, x2, y2 = map(int, bbox)
            
            # 确保坐标在图像范围内
            h, w = image.shape[:2]
            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(w, x2)
            y2 = min(h, y2)
            
            if x2 <= x1 or y2 <= y1:
                logger.warning(f'人脸区域无效: x1={x1}, y1={y1}, x2={x2}, y2={y2}')
                return None
            
            # 裁剪人脸
            face_img = image[y1:y2, x1:x2]
            
            if face_img.size == 0:
                logger.warning(f'裁剪后的人脸区域为空: x1={x1}, y1={y1}, x2={x2}, y2={y2}')
                return None
            
            # 2. 转换为RGB（EmotiEffLib需要RGB格式）
            face_rgb = cv2.cvtColor(face_img, cv2.COLOR_BGR2RGB)
            
            # 3. 使用EmotiEffLib预测表情
            # predict_emotions返回tuple: (expressions, scores)
            expressions, scores = self.model.predict_emotions(face_rgb)
            
            if not expressions or scores is None:
                # 未检测到表情，返回neutral
                logger.warning(f'未检测到表情: expressions={expressions}, scores={scores}')
                return {
                    'value': 'neutral',
                    'confidence': 0.5
                }
            
            # 4. 将scores转换为概率分布
            # scores的shape=(1, 8)：1个样本，8个表情的原始分数（logits）
            scores_array = scores[0]  # 取第一个样本(因为是一张图片) → shape=(8,)
            
            # softmax公式：将原始分数转为0-1的概率，且总和=1
            # 公式：p_i = e^(s_i) / Σ(e^(s_j))
            # probs结构：[0.055, 0.001, 0.012, 0.004, 0.898, 0.018, 0.002, 0.009]8个表情的概率，总和=1.0，最大值对应最可能的表情
            probs = np.exp(scores_array) / np.sum(np.exp(scores_array))
            
            # 5. 找到置信度最高的表情
            max_idx = np.argmax(probs)  # 返回概率最大值的索引（0-7）
            expression_name = settings.EXPRESSION_LABELS[max_idx]  # 通过索引获取表情名称
            confidence = round(float(probs[max_idx]), 3)  # 获取对应的置信度，保留3位小数
            
            # 6. 映射到标准表情名称（使用配置的统一映射表）
            standard_expression = settings.EXPRESSION_MAP.get(expression_name, 'neutral')
            
            # 7. 返回真实的模型输出
            return {
                'value': standard_expression,
                'confidence': confidence  # 真实的置信度，即使很低也如实返回
            }
            
        except Exception as e:
            logger.error(f'单个人脸表情分析失败: {e}')
            return None