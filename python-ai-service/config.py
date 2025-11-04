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
    
    # ========== 人脸质量控制配置 ==========
    
    # 质量控制阈值
    MIN_FACE_SIZE = int(os.getenv("MIN_FACE_SIZE", "60"))  # 最小人脸尺寸（像素）- 降低到60px，符合行业标准（识别最低门槛50px），平衡召回率和识别准确度
    MIN_QUALITY_SCORE = float(os.getenv("MIN_QUALITY_SCORE", "0.5"))  # 最低质量分 - 降低到0.5，接受质量稍差的人脸
    MAX_YAW_ANGLE = float(os.getenv("MAX_YAW_ANGLE", "75"))  # 最大偏航角（左右转头）- 提高到75°，在保证识别准确度的前提下接受更大的侧面角度
    MAX_PITCH_ANGLE = float(os.getenv("MAX_PITCH_ANGLE", "85"))  # 最大俯仰角（上下点头）- 提高到85°，容忍姿态估计误差（特别是婴儿和抓拍场景）
    
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
    
    # YOLOv11x 初始检测阈值
    # 说明：后处理时保留候选框的最低置信度
    # YOLOv11x 精度更高，提高到0.30，过滤低置信度误检框（0.25-0.30区间）
    # 置信度在 [INITIAL_THRESHOLD, HIGH_CONF_THRESHOLD) 区间的框，需要通过姿态验证
    YOLOV11X_INITIAL_THRESHOLD = float(os.getenv("YOLOV11X_INITIAL_THRESHOLD", "0.30"))
    
    # YOLOv11x 高置信度阈值
    # 说明：检测框置信度 >= 此值时，直接接受（不做额外验证）
    # YOLOv11x 高置信度检测更可靠，提高到0.50，直接信任更多检测
    # 置信度在 [INITIAL_THRESHOLD, HIGH_CONF_THRESHOLD) 区间的框，需要通过姿态验证
    YOLOV11X_HIGH_CONF_THRESHOLD = float(os.getenv("YOLOV11X_HIGH_CONF_THRESHOLD", "0.50"))
    
    # 人体框尺寸过滤阈值（相对图像短边的比例）
    # 说明：人体框短边 >= 图像短边 * 此比例，用于过滤远景小人
    # 6% 配合后续的关键点部位判断、姿态验证、NMS去重，既能检测小人物又能过滤误检
    PERSON_BOX_MIN_SIZE_RATIO = float(os.getenv("PERSON_BOX_MIN_SIZE_RATIO", "0.06"))  # 6%
    
    # NMS 去重 IoU 阈值
    # 说明：两个框的 IoU >= 此值时，视为同一人物，保留置信度更高的
    # 设置为0.55：平衡"大人抱宝宝"场景和避免误检的折中值
    # - 0.55阈值可以去除高度重叠的重复检测（IoU≥0.55）
    # - 同时保留真实重叠的人物（IoU通常在0.40-0.55之间）
    PERSON_NMS_IOU_THRESHOLD = float(os.getenv("PERSON_NMS_IOU_THRESHOLD", "0.55"))  # 0.55
    
    # ========== 姿态估计配置 ==========
    
    # RTMW 姿态验证阈值
    # 说明：用于判断低置信度检测框是否为真实人物（提高要求，减少误检）
    POSE_MIN_VALID_RATIO = float(os.getenv("POSE_MIN_VALID_RATIO", "0.7"))  # 有效关键点最小比例（提高到0.7，更严格）
    POSE_MIN_SCORE = float(os.getenv("POSE_MIN_SCORE", "0.50"))              # 关键点平均置信度最小值（提高到0.50，更严格）
    
    # RTMW 关键点置信度阈值（用于各种判断）
    POSE_KEYPOINT_CONF_THRESHOLD = float(os.getenv("POSE_KEYPOINT_CONF_THRESHOLD", "0.3"))  # 关键点置信度阈值（用于姿态质量评估）
    POSE_BODY_PART_CONF_THRESHOLD = float(os.getenv("POSE_BODY_PART_CONF_THRESHOLD", "0.4"))  # 身体部位判断的关键点置信度阈值
    
    # RTMW 检测框扩展比例
    # 说明：对检测框进行仿射变换前，先扩展框以包含更多上下文信息
    POSE_BBOX_PADDING = float(os.getenv("POSE_BBOX_PADDING", "1.25"))  # 检测框扩展比例（1.25 = 125%）
    
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
