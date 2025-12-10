#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸聚类服务
人脸特征聚类业务逻辑
"""

import numpy as np
from logger import logger
from config import settings
from loaders.model_loader import get_insightface_model


def ensure_model_loaded():
    """确保所有AI模型已加载"""
    try:
        get_insightface_model()  # 会自动加载所有模型，如果失败会抛出异常
        return True
    except Exception as e:
        logger.error(f"模型加载失败: {str(e)}")
        return False


def perform_clustering(embeddings, threshold=None):
    """执行人脸聚类
    
    Args:
        embeddings: 人脸特征向量列表，每个向量代表一个人脸
        threshold: 聚类阈值，用于判断两个特征向量是否属于同一类
                  值越小聚类越严格（同一人的不同照片可能被分到不同类）
                  值越大聚类越宽松（不同人的照片可能被分到同一类）
                  默认值从配置文件读取
    
    Returns:
        list: 聚类结果列表，每个元素包含一个聚类组的信息
        
    Raises:
        Exception: 聚类处理失败
    """
    try:
        from sklearn.cluster import DBSCAN
        
        # 使用配置文件中的默认值（如果未提供）
        if threshold is None:
            threshold = settings.FACE_CLUSTERING_THRESHOLD
            logger.info(f"使用默认阈值: {threshold}")
        else:
            logger.info(f"使用传入的阈值: {threshold}")
        
        # 转换为 numpy 数组
        # embeddings 是 Python 列表，需要转换为 NumPy 数组供 scikit-learn 使用
        embeddings_array = np.array(embeddings, dtype=np.float32)
        
        # 确保 embedding 已归一化（InsightFace 通常已归一化，但为了安全再次归一化）
        # L2 归一化：确保每个向量的模长为 1，这对余弦距离很重要
        norms = np.linalg.norm(embeddings_array, axis=1, keepdims=True)
        norms[norms == 0] = 1  # 避免除零
        embeddings_normalized = embeddings_array / norms
        
        # 使用 DBSCAN 聚类算法，使用余弦距离（cosine distance）
        # 行业最佳实践（2025）：对于 L2 归一化的人脸特征向量，使用余弦距离更合适
        # - 余弦距离范围：[0, 2]，其中 0 表示完全相同，2 表示完全相反
        # - 对于归一化向量，余弦距离 = 1 - 余弦相似度
        # - 同一人的不同照片，余弦距离通常在 0.2-0.6 之间
        # - 不同人的照片，余弦距离通常在 0.6-1.5 之间
        # 
        # DBSCAN 参数说明：
        # - eps: 邻域半径，使用余弦距离时，阈值范围通常是 0.2-0.8
        # - min_samples: 形成密集区域的最小样本数（设为1，允许单点聚类）
        # - metric: 'cosine' 表示使用余弦距离
        clustering = DBSCAN(eps=threshold, min_samples=1, metric='cosine')
        cluster_labels = clustering.fit_predict(embeddings_normalized)
        
        # 记录实际使用的阈值和距离度量（用于调试和验证）
        logger.info(f"执行聚类: embedding数量={len(embeddings)}, 使用阈值={threshold}, 距离度量=cosine, 归一化=已归一化")
        
        # 组织聚类结果
        # cluster_labels 是一个数组，每个元素是对应特征向量的聚类标签
        # 例如：[0, 0, 1, 1, 2] 表示前两个向量属于聚类0，中间两个属于聚类1，最后一个属于聚类2
        clusters = {}
        for i, label in enumerate(cluster_labels):
            if label not in clusters:
                clusters[label] = []  # 初始化聚类组
            clusters[label].append(i)  # 将特征向量的索引添加到对应聚类组
        
        # 转换为列表格式，便于 JSON 序列化
        cluster_list = []
        for cluster_id, face_indices in clusters.items():
            cluster_list.append({
                'cluster_id': int(cluster_id),      # 聚类组ID（-1表示噪声点/孤立点）
                'face_indices': face_indices,       # 属于该聚类的人脸索引列表
                'face_count': len(face_indices)     # 该聚类中的人脸数量
            })
        
        return cluster_list
        
    except Exception as e:
        logger.error(f"聚类失败: {str(e)}")
        raise
