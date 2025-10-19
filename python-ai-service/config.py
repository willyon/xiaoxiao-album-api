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
    
    # 环境配置
    PYTHON_ENV = os.getenv("PYTHON_ENV", "development")
    
    # ========== 图片处理配置 ==========
    
    # 最大图片字节数配置
    # float() - 将字符串转换为浮点数
    # * 1024 * 1024 - 将MB转换为字节数(1MB = 1024*1024字节)
    # int() - 最后转换为整数
    MAX_IMAGE_BYTES = int(float(os.getenv("MAX_IMAGE_MB", "50")) * 1024 * 1024)
    
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
    # 640×640 尺寸选择的科学依据：
    # 1. 性能平衡：在检测精度和处理速度之间取得最佳平衡
    #    - 比512×512精度更高，能检测到更小的人脸
    #    - 比800×800处理速度更快，资源消耗更少
    # 2. 模型标准：现代人脸检测模型(RetinaFace、MTCNN等)的常用输入尺寸
    # 3. 硬件兼容：适合大多数GPU/CPU处理，不会导致内存溢出
    # 4. 检测能力：通常能检测到16×16像素以上的小人脸
    # 
    # 工作流程：
    # 原始图片 → 缩放到640×640 → 人脸检测 → 坐标映射回原图
    # 例如：2000×1500图片缩放到640×640检测，结果坐标再映射回原图尺寸
    # 
    # 其他可选尺寸：
    # - 320×320：速度最快，精度较低，适合移动端
    # - 512×512：速度较快，精度中等
    # - 800×800：精度较高，速度较慢
    # - 1024×1024：精度最高，速度最慢，资源消耗大
    # 
    # 格式说明：宽度,高度 (用逗号分隔)
    # 例如：FACE_DET_SIZE=800,600 或 FACE_DET_SIZE=640,640
    FACE_DET_SIZE = tuple(map(int, os.getenv("FACE_DET_SIZE", "640,640").split(",")))
    
    # 人脸属性分析最大数量配置
    # 
    # 重要说明：这个参数不是限制检测的人脸总数，而是限制进行属性分析的人脸数量
    # 工作流程：
    # 1. 检测所有人脸（不受此限制）
    # 2. 按检测置信度排序（置信度高的优先）
    # 3. 只对前N个人脸进行年龄、性别、情绪、种族等属性分析
    # 4. 其他人脸只返回位置信息（bbox）、置信度和特征向量
    # 
    # 性能考虑：
    # - 人脸检测：快速（毫秒级）
    # - 属性分析：较慢（每人脸几百毫秒）
    # - 10个人脸检测：~100ms
    # - 5个人脸属性分析：~1000ms
    # - 10个人脸属性分析：~2000ms
    # 
    # 建议设置：
    # - 实时应用：1-3
    # - 相册批量处理：5-10  
    # - 专业分析：20+
    # - 移动端：3-5
    # 
    # 当前设置为20，适合相册应用分析所有人脸属性
    # 如果照片中人数超过20人，建议分批处理或增加服务器资源
    FACE_ATTR_MAX = int(os.getenv("FACE_ATTR_MAX", "20"))
    
    # 人脸检测置信度阈值配置
    # 
    # 置信度说明：
    # - 范围：0.0 - 1.0 (0% - 100% 确信度)
    # - 影响因素：人脸大小、清晰度、角度、光照、遮挡等
    # - 高置信度：大脸、清晰、正面、光照良好、无遮挡
    # - 低置信度：小人脸、模糊、侧面、光照差、有遮挡
    # 
    # 阈值建议：
    # - 实时应用：0.7-0.8 (平衡速度和准确性)
    # - 相册应用：0.6-0.7 (不遗漏重要人脸，推荐)
    # - 安全监控：0.8-0.9 (高准确性要求)
    # - 移动端：0.7-0.8 (资源限制)
    # - 专业分析：0.5-0.6 (不遗漏任何人脸)
    # 
    # 当前设置0.6，适合相册应用，能检测到大部分人脸包括一些模糊的
    FACE_DET_CONFIDENCE_THRESHOLD = float(os.getenv("FACE_DET_CONFIDENCE_THRESHOLD", "0.6"))
    
    # ========== 人脸识别配置 ==========
    
    # 质量控制阈值
    MIN_FACE_SIZE = int(os.getenv("MIN_FACE_SIZE", "120"))  # 最小人脸尺寸（像素）
    MIN_QUALITY_SCORE = float(os.getenv("MIN_QUALITY_SCORE", "0.6"))  # 最低质量分
    MAX_YAW_ANGLE = float(os.getenv("MAX_YAW_ANGLE", "45"))  # 最大偏航角
    MAX_PITCH_ANGLE = float(os.getenv("MAX_PITCH_ANGLE", "30"))  # 最大俯仰角
    
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
    
    # ========== OCR 配置 ==========
    
    # OCR功能开关配置
    OCR_ENABLED = os.getenv("OCR_ENABLED", "false").lower() in ("true", "1", "yes")
    

# ========== 创建全局配置实例 ==========

# 创建Settings类的实例，供其他文件导入使用
# 其他文件可以通过 "from config import settings" 来使用这个配置对象
settings = Settings()
