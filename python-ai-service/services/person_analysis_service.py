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
from services.person_detector import PersonDetector
from utils.images import convert_to_opencv


# 全局单例
_face_detector = None
_attribute_analyzer = None
_expression_analyzer = None
_person_detector = None


def _get_face_analyzers():
    """获取或初始化所有分析器（懒加载单例模式）"""
    global _face_detector, _attribute_analyzer, _expression_analyzer, _person_detector
    
    if _face_detector is None:
        # 初始化所有分析器（它们会自动从 loader 获取各自需要的模型）
        _face_detector = FaceDetector()
        _attribute_analyzer = FaceAttributeAnalyzer()
        _expression_analyzer = ExpressionAnalyzer()
        _person_detector = PersonDetector()  # 2025-10-27 新增：人体检测
        
        logger.info("✅ 人脸识别服务初始化完成")
    
    return _face_detector, _attribute_analyzer, _expression_analyzer, _person_detector


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


def _filter_valid_faces(all_faces):
    """
    过滤有效人脸，只保留高质量人脸
    
    用途：过滤低质量人脸，避免错误的年龄/性别/表情标签污染数据
    
    过滤条件：直接使用 face_detector 的 passed_quality 判断
    （已综合考虑：尺寸、质量分数、偏航角、俯仰角）
    
    Args:
        all_faces: 所有检测到的人脸列表
    
    Returns:
        list: 有效人脸列表（passed_quality=True 的人脸）
    """
    return [face for face in all_faces if face.get('passed_quality', False)]




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
        face_detector, attribute_analyzer, expression_analyzer, person_detector = _get_face_analyzers()
        
        # 1. 人脸检测（InsightFace SCRFD）- 返回所有检测到的人脸
        detection_result = face_detector.detect(image)
        all_faces = detection_result['all_faces']
        all_faces_count = detection_result['all_faces_count']
        
        # 2. 过滤有效人脸（优先处理，确保后续逻辑使用的都是高质量人脸）
        valid_faces = _filter_valid_faces(all_faces)
        valid_face_count = len(valid_faces)
        
        # 3. 人体检测（YOLOv11x）- 检测所有人物（包括背面、远景）
        person_result = person_detector.detect(image)
        person_count = person_result['person_count']
        
        # 4. 综合人物数量 - 取人体检测和人脸检测的最大值（2025-10-30 优化）
        # 策略：
        # - 人体检测：严格过滤，减少误检（可能漏检）
        # - 人脸检测：敏感准确，用于兜底（避免漏检）
        # - 取最大值：既保证不漏人，又通过人体检测过滤远景误检
        total_person_count = max(person_count, valid_face_count)
        
        # 如果人脸数 > 人体数，说明人体检测漏检了（如胸前宝宝被NMS去重）
        if valid_face_count > person_count > 0:
            logger.warning(f'⚠️  人脸数({valid_face_count}) > 人体数({person_count})，使用人脸数（可能是重叠人物如胸前宝宝）')
        elif person_count == 0 and valid_face_count > 0:
            logger.info(f'✅ YOLOv11x失败，使用人脸兜底: {valid_face_count}张有效人脸')
        
        logger.info(f'人物统计: 人脸={all_faces_count}→{valid_face_count}(有效), 人体={person_count}, 综合={total_person_count}')
        
        if valid_face_count == 0:
            # 没有检测到有效人脸，但可能有人体（背面、远景等）
            return {
                'face_count': 0,
                'person_count': total_person_count,
                'faces': [],
                'summary': {
                    'expressions': [],
                    'ages': [],
                    'genders': []
                }
            }
        
        # 5. 对有效人脸进行属性分析
        attributes = attribute_analyzer.analyze(image, valid_faces)
        expressions = expression_analyzer.analyze(image, valid_faces)
        
        # 确保三个列表长度一致
        if len(valid_faces) != len(attributes) or len(valid_faces) != len(expressions):
            logger.error(f'列表长度不一致！valid_faces={len(valid_faces)}, attributes={len(attributes)}, expressions={len(expressions)}')
            raise ValueError(f'人脸分析结果长度不一致：valid_faces={len(valid_faces)}, attributes={len(attributes)}, expressions={len(expressions)}')
        
        # 6. 合并结果（处理有效人脸）
        face_results = []
        summary_expressions = []
        summary_ages = []
        summary_genders = []
        
        for i, (face, attr, expr) in enumerate(zip(valid_faces, attributes, expressions)):
            # 构建单个人脸结果
            face_result = {
                'face_index': i,
                'bbox': face['bbox'],
                'confidence': face['det_score'],
                'quality_score': face['quality_score'],
                'pose': face['pose'],
                'embedding': face['embedding'],
                'is_high_quality': face['passed_quality'],  # 标记是否为高质量人脸
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
        
        # 7. 返回结果（转换所有numpy类型为Python原生类型）
        result = {
            'face_count': valid_face_count,  # 有效人脸数量（已过滤低质量）
            'person_count': total_person_count,  # 人物总数（优先人体检测）
            'faces': face_results,  # 有效人脸的详细信息
            'summary': {
                'expressions': summary_expressions,
                'ages': summary_ages,
                'genders': summary_genders
            }
        }
        
        # 转换numpy类型，确保JSON序列化兼容
        result = _convert_to_native_types(result)
        
        logger.info(f"✅ 人脸分析完成: 检测到{all_faces_count}张人脸，过滤后{valid_face_count}张有效人脸")
        
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

