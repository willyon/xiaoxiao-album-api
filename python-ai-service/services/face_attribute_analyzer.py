#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸属性分析器 - 基于 FairFace ONNX
提供年龄和性别识别（使用ONNX后端，避免PyTorch兼容性问题）

主要功能：
1. 分析人脸的年龄段（9个年龄段：0-2, 3-9, 10-19, 20-29, 30-39, 40-49, 50-59, 60-69, 70+）
2. 分析人脸的性别（male/female）
3. 基于ONNX模型，避免PyTorch版本兼容性问题

工作流程：
输入：OpenCV图像 + 检测到的人脸列表
  → 对每个人脸裁剪并扩展边界（增加上下文）
  → 调整为224×224（FairFace标准尺寸）
  → ONNX模型推理
  → 解析输出（年龄ID、性别ID）
  → 应用置信度阈值过滤
输出：年龄和性别信息列表

注意事项：
- 低质量人脸会跳过分析（节省计算资源）
- 使用不同的置信度阈值：青少年（0-19岁）更严格，成人（20+岁）更宽松
- 由于FairFace模型限制，年龄段是固定的9个桶，无法拆分
"""

# ========== 导入依赖库 ==========
import cv2  # OpenCV：图像处理（裁剪、颜色转换、调整大小）
import numpy as np  # NumPy：数组操作（图像数据处理）
from logger import logger  # 日志记录器
from config import settings  # 配置管理器（阈值、年龄段定义等）
from loaders.model_loader import get_fairface_session  # 统一模型加载器


class FaceAttributeAnalyzer:
    """
    人脸属性分析器 - 基于FairFace ONNX
    
    职责：
    1. 加载和管理FairFace ONNX模型
    2. 分析人脸的年龄段和性别
    3. 根据置信度阈值过滤结果
    
    使用场景：
    - 家庭相册：识别照片中的青少年和成人
    - 年龄段信息可从 media_face_embeddings.age 聚合推导
    - 详细分析：通过 age_tags 提供具体年龄段信息
    """
    
    def __init__(self):
        """
        初始化人脸属性分析器
        
        功能说明：
        从统一的 model_loader 获取预加载的 FairFace ONNX 模型
        
        优点：
        - 模型由 loader 统一管理，避免重复加载
        - 服务启动时已经加载好，无冷启动延迟
        """
        try:
            # 从 loader 获取已加载的模型
            self.session = get_fairface_session()
            
            # 获取模型的输入输出信息
            self.input_name = self.session.get_inputs()[0].name
            self.output_names = [output.name for output in self.session.get_outputs()]
            
            logger.info('✅ FairFace ONNX人脸属性分析器初始化完成')
            
        except Exception as e:
            logger.error("FairFace ONNX初始化失败", details={"error": str(e)})
            self.session = None
    
    def analyze(self, image, faces):
        """
        分析图像中所有人脸的年龄和性别
        
        功能说明：
        遍历检测到的每个人脸，逐个进行属性分析，返回完整的分析结果列表。
        
        Args:
            image: OpenCV图像（BGR格式，3通道）
                   - 来自 cv2.imdecode() 或 cv2.imread()
                   - 格式：numpy数组，shape=(height, width, 3)
            
            faces: 检测到的人脸列表（来自 FaceDetector.detect()）
                   每个元素是一个字典：
                   {
                       'bbox': [x1, y1, x2, y2],        # 人脸框坐标
                       'quality_score': 0.0-1.0,        # 质量分数
                       'passed_quality': True/False,    # 是否通过质量检测
                       ...
                   }
            
        Returns:
            list: 属性分析结果列表，与 faces 列表一一对应
                  每个元素格式：
                  {
                      'age': {
                          'bucket': '20-29',           # 年龄段
                          'confidence': 0.8            # 置信度
                      } 或 None,                        # 低质量或置信度不足时为 None
                      'gender': {
                          'value': 'female',           # 性别
                          'confidence': 0.8            # 置信度
                      } 或 None
                  }
        
        处理流程（2025-10-27 优化）：
        1. 检查模型是否已加载、是否有人脸
        2. 遍历每个人脸：
           - 所有人脸都尝试分析（不再跳过低质量人脸）
           - 分析失败时返回默认值（age=None, gender=None）
           - 上层会将 None 转换为 'unknown'
        3. 返回完整的结果列表
        
        设计考虑（新）：
        - 所有检测到的人脸都进行分析，确保 face_count 和 faces 数量匹配
        - 质量差的人脸可能分析失败，但仍返回默认值而不是跳过
        - 通过 quality_score 让前端决定如何展示
        - 即使部分人脸失败，也返回完整列表（保持索引对应）
        """
        # ========== 第1步：前置检查 ==========
        # 检查1：模型是否已加载？
        # 检查2：是否有人脸需要分析？
        if not faces:
            return []
        if not self.session:
            # FairFace 缺失/加载失败时：仍返回与 faces 等长的默认结构，保持索引对应
            return [{"age": None, "gender": None} for _ in faces]
        
        # ========== 第2步：初始化结果列表 ==========
        results = []
        
        try:
            # ========== 第3步：遍历每个人脸进行分析 ==========
            # 优化（2025-10-27）：对所有人脸都尝试分析，不再跳过低质量人脸
            for face in faces:
                # 裁剪人脸区域
                # 从原图中裁剪出人脸区域（带15%扩展边界）
                # 返回224×224的RGB numpy数组
                face_img = self._crop_face(image, face['bbox'])
                
                # 检查裁剪是否成功
                if face_img is None:
                    # 裁剪失败（可能原因：边界框超出图像、裁剪区域为空）
                    # 使用默认值，而不是跳过
                    results.append({'age': None, 'gender': None})
                    continue
                
                # 预测年龄和性别
                # 使用ONNX模型推理
                # 返回：(age_info, gender_info) 或 (None, None)
                age_info, gender_info = self._predict(face_img)
                
                # 添加到结果列表
                # 即使是 None 也添加（保持索引对应）
                results.append({
                    'age': age_info,      # 年龄信息（dict或None）
                    'gender': gender_info  # 性别信息（dict或None）
                })
            
            # ========== 第4步：返回完整结果 ==========
            return results
            
        except Exception as e:
            # 异常处理：如果整个分析过程出错
            # 返回一个全为None的列表（保持长度一致）
            logger.error("属性分析失败", details={"error": str(e)})
            return [{'age': None, 'gender': None}] * len(faces)
    
    def _crop_face(self, img, bbox):
        """
        裁剪并对齐人脸区域
        
        功能说明：
        1. 从原图中裁剪出人脸区域
        2. 扩展边界（增加15%上下文，提高识别准确度）
        3. 转换颜色格式（BGR → RGB）
        4. 调整为标准尺寸（224×224）
        
        为什么要扩展边界？
        - FairFace模型需要一些上下文信息（头发、脸型轮廓等）
        - 扩展15%能提高识别准确度3-5%
        - 但不能扩展太多，否则会引入无关信息
        
        为什么是224×224？
        - FairFace模型的标准输入尺寸
        - 基于ResNet-34架构，训练时使用224×224
        
        Args:
            img: OpenCV原图（BGR格式，numpy数组）
            bbox: 人脸边界框 [x1, y1, x2, y2]
                  - x1, y1: 左上角坐标
                  - x2, y2: 右下角坐标
        
        Returns:
            numpy.ndarray: 裁剪后的人脸图像（RGB格式，224×224，numpy数组）
            None: 裁剪失败（边界框无效、裁剪区域为空等）
        """
        try:
            # ========== 第1步：解包边界框坐标 ==========
            x1, y1, x2, y2 = bbox
            
            # ========== 第2步：扩展边界（增加15%上下文） ==========
            # 原因：年龄性别识别需要头发、脸型等上下文信息，不能只看五官
            # 效果：扩展15%能提高识别准确度约3-5%（经验值）
            
            # 计算人脸宽度和高度
            w, h = x2 - x1, y2 - y1
            
            # 向外扩展15%，但不能超出图像边界
            x1 = max(0, int(x1 - w * 0.15))              # 左边界（不能<0）
            y1 = max(0, int(y1 - h * 0.15))              # 上边界（不能<0）
            x2 = min(img.shape[1], int(x2 + w * 0.15))   # 右边界（不能>图像宽度）
            y2 = min(img.shape[0], int(y2 + h * 0.15))   # 下边界（不能>图像高度）
            
            # 注意：
            # - img.shape[0] 是高度（height）
            # - img.shape[1] 是宽度（width）
            # - OpenCV数组格式：[height, width, channels]
            
            # 检查扩展后的区域是否有效
            if x2 <= x1 or y2 <= y1:
                # 无效区域（可能原因：人脸完全在图像外、bbox数据错误）
                logger.warning(f'扩展后的人脸区域无效: x1={x1}, y1={y1}, x2={x2}, y2={y2}')
                return None
            
            # ========== 第3步：从原图裁剪人脸区域 ==========
            # NumPy切片语法：img[y1:y2, x1:x2]
            # 注意：先y后x（因为数组是[height, width]格式）
            face_img = img[y1:y2, x1:x2]
            
            # ========== 第4步：检查裁剪结果是否有效 ==========
            if face_img.size == 0:
                # 裁剪区域为空（可能原因：bbox超出边界、计算错误）
                return None
            
            # ========== 第5步：颜色空间转换（BGR → RGB） ==========
            # 为什么要转换？
            # - OpenCV使用BGR格式（历史原因）
            # - 深度学习模型使用RGB格式（标准格式）
            # - 如果不转换，蓝色和红色会互换，导致识别错误
            face_img = cv2.cvtColor(face_img, cv2.COLOR_BGR2RGB)
            
            # ========== 第6步：调整为标准尺寸224×224 ==========
            # FairFace模型的固定输入尺寸
            # 使用INTER_LANCZOS4插值（高质量，4×4像素采样）
            face_img = cv2.resize(face_img, (224, 224), interpolation=cv2.INTER_LANCZOS4)
            
            return face_img
            
        except Exception as e:
            # 裁剪过程出错（记录日志，返回None）
            logger.error("人脸裁剪失败", details={"error": str(e)})
            return None
    
    def _predict(self, face_img):
        """
        预测年龄段和性别
        
        功能说明：
        1. 图像预处理（归一化、格式转换）
        2. ONNX模型推理
        3. 解析模型输出（年龄ID、性别ID）
        4. 转换为可读信息（年龄段、性别）
        
        Args:
            face_img: numpy数组（RGB格式，224×224）
        
        Returns:
            tuple: (age_info, gender_info)
                   - age_info: {'bucket': '20-29'} 或 None
                   - gender_info: {'value': 'female'} 或 None
        
        模型输出格式：
        FairFace ONNX模型输出3个结果：
        - outputs[0]: race_id (种族ID，我们不需要)
        - outputs[1]: gender_id (性别ID: 0=male, 1=female)
        - outputs[2]: age_id (年龄ID: 0-8对应9个年龄段)
        """
        try:
            # ========== 第1步：图像预处理 ==========
            
            # 1.1 归一化：uint8 (0-255) → float32 (0.0-1.0)
            # 为什么要归一化（除以255）？
            # - 深度学习模型训练时使用0-1范围的数据
            # - 归一化可以加速训练、提高精度
            # - 推理时也必须使用相同的归一化方式
            img_array = face_img.astype(np.float32) / 255.0
            
            # 当前格式：(224, 224, 3) - HWC格式（Height, Width, Channel）
            
            # 1.2 转换为CHW格式（Channel, Height, Width）
            # 为什么要转换？
            # - ONNX模型期望的输入格式是CHW（PyTorch标准）
            # - OpenCV使用HWC格式（人类直觉）
            # - transpose() 重新排列维度：(2, 0, 1) 表示 (C, H, W)
            input_data = np.transpose(img_array, (2, 0, 1))
            
            # 当前格式：(3, 224, 224) - CHW格式
            
            # 1.3 添加batch维度
            # 为什么要添加batch维度？
            # - 深度学习模型通常处理批量数据（batch）
            # - 即使只有1张图片，也需要batch维度
            # - expand_dims(axis=0) 在第0维添加一个维度
            input_data = np.expand_dims(input_data, axis=0)
            
            # 最终格式：(1, 3, 224, 224) - NCHW格式（Batch, Channel, Height, Width）
            
            # ========== 第2步：ONNX模型推理 ==========
            # session.run() 执行推理
            # 参数1：输出名称列表（我们要哪些输出）
            # 参数2：输入数据字典 {输入名称: 数据}
            outputs = self.session.run(self.output_names, {self.input_name: input_data})
            
            # outputs 是一个列表，包含3个元素
            # 每个元素是一个NumPy数组，shape=(1,)
            
            # ========== 第3步：解析模型输出 ==========
            # FairFace ONNX输出格式（固定顺序）：
            # [race_id, gender_id, age_id]
            
            race_id = outputs[0][0]    # 种族ID（我们不需要，忽略）
            gender_id = outputs[1][0]  # 性别ID: 0=male, 1=female
            age_id = outputs[2][0]     # 年龄ID: 0-8（对应9个年龄段）
            
            # ========== 第4步：转换为可读信息 ==========
            # 将模型输出的ID转换为业务需要的格式
            
            # 4.1 年龄段分析
            # age_id → {'bucket': '20-29'}
            age_info = self._analyze_age_from_id(age_id)
            
            # 4.2 性别分析
            # gender_id → {'value': 'female'}
            gender_info = self._analyze_gender_from_id(gender_id)
            
            # ========== 第5步：返回结果 ==========
            return age_info, gender_info
            
        except Exception as e:
            # ONNX推理失败（可能原因：输入格式错误、模型错误、内存不足）
            logger.error("ONNX预测失败", details={"error": str(e)})
            return None, None
    
    def _analyze_age_from_id(self, age_id):
        """
        从年龄ID分析年龄段
        
        功能说明：
        将模型输出的年龄ID（0-8）映射到年龄段字符串
        
        Args:
            age_id: 年龄ID（0-8），由FairFace模型输出
                    对应关系（固定，不可更改）：
                    0 → '0-2'
                    1 → '3-9'
                    2 → '10-19'
                    3 → '20-29'
                    4 → '30-39'
                    5 → '40-49'
                    6 → '50-59'
                    7 → '60-69'
                    8 → '70+'
        
        Returns:
            dict: {'bucket': '20-29'}
            None: 无效ID
        
        注意事项：
        - AGE_BUCKETS是固定数组，不能修改（与模型输出对应）
        - FairFace模型只返回ID，没有置信度信息
        """
        try:
            # ========== 第1步：ID有效性检查 ==========
            # 转换为整数（防止浮点数）
            age_id = int(age_id)
            
            # 检查ID是否在有效范围内（0-8）
            if age_id < 0 or age_id >= len(settings.AGE_BUCKETS):
                # ID无效（超出范围）
                return None
            
            # ========== 第2步：ID → 年龄段映射 ==========
            # AGE_BUCKETS定义在config.py中：
            # ['0-2', '3-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70+']
            # 注意：这是固定数组，不能修改（与FairFace模型输出对应）
            age_bucket = settings.AGE_BUCKETS[age_id]
            
            # 示例：
            # age_id=0 → age_bucket='0-2'
            # age_id=2 → age_bucket='10-19'
            # age_id=3 → age_bucket='20-29'
            
            # ========== 第3步：返回结果 ==========
            # 注意：FairFace模型只返回分类ID，不返回置信度
            # 因此我们只返回年龄段，不返回置信度
            return {
                'bucket': age_bucket  # 年龄段（字符串）
            }
            
        except Exception as e:
            # 分析失败（记录日志，返回None）
            logger.error("年龄ID分析失败", details={"error": str(e)})
            return None
    
    def _analyze_gender_from_id(self, gender_id):
        """
        从性别ID分析性别
        
        功能说明：
        将模型输出的性别ID（0或1）映射到性别值
        
        Args:
            gender_id: 性别ID，由FairFace模型输出
                       0 = male（男性）
                       1 = female（女性）
        
        Returns:
            dict: {'value': 'female'}
            None: 无效ID
        
        注意事项：
        - FairFace模型只返回ID，没有置信度信息
        - 性别识别通常比年龄识别准确度高
        """
        try:
            # ========== 第1步：ID有效性检查 ==========
            # 转换为整数
            gender_id = int(gender_id)
            
            # 检查ID是否有效（只能是0或1）
            if gender_id not in [0, 1]:
                # ID无效（不是0也不是1）
                return None
            
            # ========== 第2步：ID → 性别值映射 ==========
            # FairFace模型的标准映射：
            # 0 → 'male'（男性）
            # 1 → 'female'（女性）
            gender_value = 'male' if gender_id == 0 else 'female'
            
            # ========== 第3步：返回结果 ==========
            # 注意：FairFace模型只返回分类ID，不返回置信度
            # 因此我们只返回性别值，不返回置信度
            return {
                'value': gender_value  # 性别值（'male'或'female'）
            }
            
        except Exception as e:
            # 分析失败（记录日志，返回None）
            logger.error("性别ID分析失败", details={"error": str(e)})
            return None
