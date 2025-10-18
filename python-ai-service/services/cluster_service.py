#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸聚类服务
人脸特征聚类业务逻辑
"""

import numpy as np
from logger import logger
from loaders.face_loader import get_insightface_model


def ensure_model_loaded():
    """确保所有AI模型已加载"""
    try:
        get_insightface_model()  # 会自动加载所有模型，如果失败会抛出异常
        return True
    except Exception as e:
        logger.error(f"模型加载失败: {str(e)}")
        return False


def perform_clustering(embeddings, threshold=0.4):
    """执行人脸聚类
    
    Args:
        embeddings: 人脸特征向量列表，每个向量代表一个人脸
        threshold: 聚类阈值，用于判断两个特征向量是否属于同一类
                  值越小聚类越严格（同一人的不同照片可能被分到不同类）
                  值越大聚类越宽松（不同人的照片可能被分到同一类）
    
    Returns:
        list: 聚类结果列表，每个元素包含一个聚类组的信息
        
    Raises:
        Exception: 聚类处理失败
    """
    try:
        from sklearn.cluster import DBSCAN
        
        # 转换为 numpy 数组
        # embeddings 是 Python 列表，需要转换为 NumPy 数组供 scikit-learn 使用
        embeddings_array = np.array(embeddings)
        
        # 使用 DBSCAN 聚类算法
        # DBSCAN: Density-Based Spatial Clustering of Applications with Noise
        # eps: 邻域半径，两个样本的最大距离（对应 threshold 参数）
        # min_samples: 形成密集区域的最小样本数（设为1，允许单点聚类）
        clustering = DBSCAN(eps=threshold, min_samples=1)
        cluster_labels = clustering.fit_predict(embeddings_array)
        
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
