#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸识别服务
使用 SCRFD + FairFace 架构，替代 DeepFace
"""

import numpy as np
from logger import logger
from services.face_detector import FaceDetector
from services.face_attribute_analyzer import FaceAttributeAnalyzer
from services.expression_analyzer import ExpressionAnalyzer
from utils.images import convert_to_opencv


# 全局单例
_face_detector = None
_attribute_analyzer = None
_expression_analyzer = None


def _get_face_analyzers():
    """获取或初始化人脸分析器（懒加载单例模式）"""
    global _face_detector, _attribute_analyzer, _expression_analyzer
    
    if _face_detector is None:
        # 初始化所有分析器（它们会自动从 loader 获取各自需要的模型）
        _face_detector = FaceDetector()
        _attribute_analyzer = FaceAttributeAnalyzer()
        _expression_analyzer = ExpressionAnalyzer()
        
        logger.info("✅ 人脸识别服务初始化完成")
    
    return _face_detector, _attribute_analyzer, _expression_analyzer


def process_image_from_bytes(image_bytes):
    """
    从字节数据处理图片并分析人脸
    
    Args:
        image_bytes: 图片字节数据
    
    Returns:
        dict: 人脸分析结果
            - face_count: 人脸数量
            - faces: 人脸详细信息列表
            - summary: 汇总信息
    
    Raises:
        ValueError: 图片格式转换失败
        Exception: 人脸分析失败
    """
    try:
        # 1. 图片格式转换
        image_data, error = convert_to_opencv(image_bytes)
        if error:
            raise ValueError(error)
        
        # 2. 人脸分析
        result = _analyze_image(image_data)
        
        return result
        
    except Exception as e:
        logger.error(f"图片处理和人脸分析失败: {str(e)}")
        raise


def _analyze_image(image):
    """
    分析图片中的人脸
    
    Args:
        image: OpenCV格式的图片
    
    Returns:
        dict: 人脸分析结果
    """
    try:
        # 获取分析器
        face_detector, attribute_analyzer, expression_analyzer = _get_face_analyzers()
        
        # 1. 人脸检测（SCRFD）- 返回分离的结果
        detection_result = face_detector.detect(image)
        high_quality_faces = detection_result['high_quality_faces']
        all_faces_count = detection_result['all_faces_count']
        
        if all_faces_count == 0:
            return {
                'face_count': 0,  # 使用所有人脸数量进行统计
                'faces': [],
                'summary': {
                    'expressions': [],
                    'ages': [],
                    'genders': []
                }
            }
        
        # 2. 属性分析（FairFace：年龄段 + 性别）- 只对高质量人脸进行分析
        attributes = attribute_analyzer.analyze(image, high_quality_faces)
        
        # 3. 表情分析 - 只对高质量人脸进行分析
        expressions = expression_analyzer.analyze(image, high_quality_faces)
        
        # 确保三个列表长度一致（用于 zip 遍历）
        if len(high_quality_faces) != len(attributes) or len(high_quality_faces) != len(expressions):
            logger.error(f'列表长度不一致！high_quality_faces={len(high_quality_faces)}, attributes={len(attributes)}, expressions={len(expressions)}')
            raise ValueError(f'人脸分析结果长度不一致：high_quality_faces={len(high_quality_faces)}, attributes={len(attributes)}, expressions={len(expressions)}')
        
        # 4. 合并结果（只处理高质量人脸）
        face_results = []
        summary_expressions = []
        summary_ages = []
        summary_genders = []
        
        for i, (face, attr, expr) in enumerate(zip(high_quality_faces, attributes, expressions)):
            # 构建单个人脸结果
            face_result = {
                'face_index': i,
                'bbox': face['bbox'],
                'confidence': face['det_score'],
                'quality_score': face['quality_score'],
                'pose': face['pose'],
                'embedding': face['embedding'],
            }
            
            # 年龄信息
            if attr['age']:
                age_bucket = attr['age']['bucket']
                face_result['age_bucket'] = age_bucket
                face_result['age'] = _bucket_to_age(age_bucket)
                # 去重添加到summary
                if age_bucket not in summary_ages:
                    summary_ages.append(age_bucket)
            else:
                face_result['age_bucket'] = 'unknown'
                face_result['age'] = None
            
            # 性别信息
            if attr['gender']:
                gender_value = attr['gender']['value']
                face_result['gender'] = gender_value
                # 去重添加到summary
                if gender_value not in summary_genders:
                    summary_genders.append(gender_value)
            else:
                face_result['gender'] = 'unknown'
            
            # 表情信息
            if expr and 'value' in expr:
                expression_value = expr['value']
                face_result['expression'] = expression_value
                face_result['expression_confidence'] = expr['confidence']
                # 去重添加到summary
                if expression_value not in summary_expressions:
                    summary_expressions.append(expression_value)
            else:
                face_result['expression'] = 'neutral'
                face_result['expression_confidence'] = 0.0
            
            face_results.append(face_result)
        
        # 5. 返回结果（转换所有numpy类型为Python原生类型）
        result = {
            'face_count': all_faces_count,  # 使用所有人脸数量进行统计（包括侧面、远距离等）
            'faces': face_results,  # 只包含高质量人脸的详细信息
            'summary': {
                'expressions': summary_expressions,
                'ages': summary_ages,
                'genders': summary_genders
            }
        }
        
        # 转换numpy类型，确保JSON序列化兼容
        result = _convert_to_native_types(result)
        
        logger.info(f"✅ 人脸分析完成: 检测到{all_faces_count}张人脸，分析{len(face_results)}张高质量人脸")
        
        return result
        
    except Exception as e:
        logger.error(f"人脸分析失败: {str(e)}", exc_info=True)
        raise


def _convert_to_native_types(obj):
    """
    将numpy类型转换为Python原生类型，确保JSON序列化兼容
    
    Args:
        obj: 任意对象
    
    Returns:
        转换后的Python原生类型对象
    """
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {key: _convert_to_native_types(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [_convert_to_native_types(item) for item in obj]
    else:
        return obj


def _bucket_to_age(bucket):
    """
    将年龄段转换为数值（取中间值）
    
    Args:
        bucket: 年龄段字符串，如 "20-29"
    
    Returns:
        int: 年龄数值
    """
    try:
        if bucket == '70+':
            return 75
        
        parts = bucket.split('-')
        if len(parts) == 2:
            # 整除运算
            return (int(parts[0]) + int(parts[1])) // 2
        
        return 0
    except:
        return 0

