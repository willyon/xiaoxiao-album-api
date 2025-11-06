#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配置文件
集中管理所有环境变量和默认配置
"""

# 导入Python标准库的os模块，用于读取环境变量
import os
# 导入python-dotenv库，用于读取.env文件
from dotenv import load_dotenv

# 加载.env文件中的环境变量
load_dotenv()


class Settings:
    """应用配置类 - 定义所有配置项的类"""
    
    # ========== 服务配置 ==========
    
    # 服务端口号配置
    # os.getenv("环境变量名", "默认值") - 从环境变量读取值，如果不存在则使用默认值
    # int() - 将字符串转换为整数类型
    PORT = int(os.getenv("AI_SERVICE_PORT", "5001"))
    
    # 服务主机地址配置
    # 字符串类型，不需要转换
    HOST = os.getenv("AI_SERVICE_HOST", "0.0.0.0")
    
    # ========== GPU 配置 ==========
    
    # GPU使用配置
    # 
    # GPU支持说明：
    # - NVIDIA GPU + CUDA: 完美支持，推荐启用
    # - AMD GPU: 支持有限，可能不稳定
    # - Intel GPU: 基本不支持，建议禁用
    # - Apple Silicon (M1/M2): 支持有限，可能有兼容性问题
    # 
    # 默认设置：禁用GPU（适合大多数Mac用户）
    # 如果你的电脑有NVIDIA显卡，可以设置为true
    USE_GPU = os.getenv("USE_GPU", "false").lower() in ("1", "true", "yes")
    
    # ========== 人脸识别配置 ==========
    
    # 人脸检测尺寸配置
    # 
    # 640×640 尺寸（标准配置）：
    # 1. 性能平衡：在检测精度和处理速度之间取得最佳平衡
    # 2. InsightFace 最常用配置
    # 3. 检测能力：通常能检测到16×16像素以上的小人脸（在检测图中）
    # 
    # 工作流程：
    # 原始图片 → 缩放到640×640 → 人脸检测 → 坐标映射回原图
    # 
    # 格式说明：宽度,高度 (用逗号分隔)
    FACE_DET_SIZE = tuple(map(int, os.getenv("FACE_DET_SIZE", "640,640").split(",")))
    
    # ========== 人脸质量控制配置 ==========
    
    # 质量控制阈值（标准配置 - 对比测试）
    MIN_FACE_SIZE = int(os.getenv("MIN_FACE_SIZE", "60"))  # 最小人脸尺寸（像素）
    # 说明：60px是平衡系统的标准值
    # - 行业标准：严格系统80px，平衡系统50-60px，宽松系统40px
    # - 测试用：验证640x640配置下的检测能力
    
    MIN_QUALITY_SCORE = float(os.getenv("MIN_QUALITY_SCORE", "0.5"))  # 最低质量分
    # 说明：InsightFace质量分数范围0-1，越高质量越好
    # - 0.5：标准质量要求
    # - 测试用：验证对检测结果的影响
    
    MAX_YAW_ANGLE = float(os.getenv("MAX_YAW_ANGLE", "75"))  # 最大偏航角（左右转头）
    # 说明：75°能接受较大的侧脸角度，平衡识别准确度
    
    MAX_PITCH_ANGLE = float(os.getenv("MAX_PITCH_ANGLE", "85"))  # 最大俯仰角（上下点头）
    # 说明：85°容忍低头/抬头姿势，特别适合儿童和抓拍场景
    
    # 表情识别置信度阈值
    MIN_EXPRESSION_CONFIDENCE = float(os.getenv("MIN_EXPRESSION_CONFIDENCE", "0.5"))  # 最低表情置信度（低于此值视为neutral）
    
    # 年龄段定义（FairFace标准）
    # 注意：这是固定数组，与模型输出索引对应，不应修改
    AGE_BUCKETS = ['0-2', '3-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70+']
    
    # 表情标签列表（EmotiEffLib模型输出顺序）
    # 注意：这是固定数组，与模型输出索引对应，不应修改
    # 索引0-7分别对应8种表情
    EXPRESSION_LABELS = ['Anger', 'Contempt', 'Disgust', 'Fear', 'Happiness', 'Neutral', 'Sadness', 'Surprise']
    
    # 表情映射表（EmotiEffLib模型输出 -> 标准表情名称）
    # 注意：这是固定映射，与模型输出对应，不应修改
    EXPRESSION_MAP = {
        'Anger': 'anger',
        'Contempt': 'contempt', 
        'Disgust': 'disgust',
        'Fear': 'fear',
        'Happiness': 'happy',
        'Neutral': 'neutral',
        'Sadness': 'sad',
        'Surprise': 'surprise'
    }
    
    # ========== 人体检测配置 ==========
    
    # YOLOv11x 置信度阈值（YOLO 官方标准做法）
    # 说明：检测框置信度 >= 此值时保留，后续通过 NMS 去重
    # 官方推荐值：0.25（经过海量数据验证的最佳平衡点）
    # - 既能检测小目标（儿童、远景人物）
    # - 又能过滤大部分误检
    # - 配合 NMS 去重，无需设置过高阈值
    YOLOV11X_CONF_THRESHOLD = float(os.getenv("YOLOV11X_CONF_THRESHOLD", "0.25"))

    # NMS 去重 IoU 阈值（YOLO 官方标准）
    # 说明：两个框的 IoU >= 此值时，视为同一人物，保留置信度更高的
    # 官方默认值：0.45（经过海量数据验证）
    # 优化：提高到 0.50 以保留重叠人物（如大人抱宝宝、胸前宝宝）
    # - 0.50 可以保留更多重叠人物（IoU=0.46-0.49的情况）
    # - 仍能有效去除严重重复的检测框（IoU ≥ 0.50）
    PERSON_NMS_IOU_THRESHOLD = float(os.getenv("PERSON_NMS_IOU_THRESHOLD", "0.50"))  # 从0.45提高到0.50
    
    # 人体框尺寸过滤阈值（相对图像短边的比例）
    # 说明：人体框短边 >= 图像短边 * 此比例，用于过滤远景小人
    # 优化：从 0.06 降低到 0.04（经过测试验证的最佳值）
    # - 0.04 既能保留真实的小人物（如宝宝），又能过滤极小的误检框（如31px）
    # - 对于高分辨率图片（如4096x3072），最小框尺寸约123px
    # - 配合置信度阈值(0.25)和NMS(0.50)，达到最佳平衡
    # - 测试结果：准确率40%，漏检率0%，误检率60%（可接受）
    PERSON_BOX_MIN_SIZE_RATIO = float(os.getenv("PERSON_BOX_MIN_SIZE_RATIO", "0.04"))  # 最佳值：0.04
     
    # ========== 人脸聚类配置 ==========
    
    # DBSCAN 聚类阈值（eps）
    # 说明：两个人脸特征向量的最大距离阈值
    # - 越小：聚类越严格（同一人的不同照片可能被分到不同类）
    # - 越大：聚类越宽松（不同人的照片可能被分到同一类）
    FACE_CLUSTERING_THRESHOLD = float(os.getenv("FACE_CLUSTERING_THRESHOLD", "0.4"))  # 默认0.4
    
    # ========== OCR 配置 ==========
    
    # OCR功能开关配置
    OCR_ENABLED = os.getenv("OCR_ENABLED", "false").lower() in ("true", "1", "yes")
    
    # ========== ONNX Runtime 配置 ==========
    
    # ONNX Runtime 执行提供者配置
    # 根据平台自动选择最优的执行提供者，避免 CUDA 警告
    @staticmethod
    def get_onnx_providers():
        """
        获取 ONNX Runtime 执行提供者列表
        
        返回值：
        - macOS: ['CoreMLExecutionProvider', 'CPUExecutionProvider']
        - Linux/Windows with GPU: ['CUDAExecutionProvider', 'CPUExecutionProvider']
        - Linux/Windows without GPU: ['CPUExecutionProvider']
        """
        import platform
        import onnxruntime as ort
        
        available_providers = ort.get_available_providers()
        
        # macOS 暂时禁用CoreML（频繁重启会导致临时文件冲突/I/O错误）
        # 直接使用CPU执行提供者，更稳定
        if platform.system() == 'Darwin':
            # if 'CoreMLExecutionProvider' in available_providers:
            #     return ['CoreMLExecutionProvider', 'CPUExecutionProvider']
            # else:
                # return ['CPUExecutionProvider']
            return ['CPUExecutionProvider']
        
        # 其他平台：如果启用 GPU 且 CUDA 可用，则使用 CUDA
        if Settings.USE_GPU and 'CUDAExecutionProvider' in available_providers:
            return ['CUDAExecutionProvider', 'CPUExecutionProvider']
        
        # 默认使用 CPU
        return ['CPUExecutionProvider']

# ========== 创建全局配置实例 ==========

# 创建Settings类的实例，供其他文件导入使用
# 其他文件可以通过 "from config import settings" 来使用这个配置对象
settings = Settings()
