"""
姿态估计器 - 基于 RTMW-x ONNX 模型

功能：对 YOLOv11x 低置信度检测框进行姿态验证
用途：提升人物检测召回率，减少漏检（远景、背影、奇怪姿势等）
模型：RTMW-x (133个全身关键点：身体17 + 手部42 + 面部68)
"""

import cv2
import numpy as np
from logger import logger
from config import settings

class PoseEstimator:
    """
    姿态估计器 - 使用 RTMW-x ONNX 模型
    
    工作流程：
    1. 接收 YOLOv11x 的检测框 (bbox)
    2. 对框内区域进行仿射变换 → 192x256
    3. ONNX 推理得到 SimCC 输出 (simcc_x, simcc_y)
    4. 解码关键点坐标和置信度
    5. 计算有效关键点比例和平均分数
    """
    
    def __init__(self):
        """
        初始化姿态估计器
        
        加载顺序：
        1. 从 model_loader 获取 ONNX session
        2. 读取 detail.json 获取模型配置
        3. 从 ONNX session 推断输出尺寸
        """
        try:
            from loaders.model_loader import get_rtmw_session
            
            self.session = get_rtmw_session()
            
            if self.session:
                # ========== 从 ONNX session 直接获取模型信息 ==========
                # 优点：
                # 1. 保证与实际模型一致，避免配置文件错误
                # 2. 代码更简洁，减少配置依赖
                # 3. 更易维护，换模型时自动适配
                
                # 获取输入信息
                self.input_name = self.session.get_inputs()[0].name
                input_shape = self.session.get_inputs()[0].shape  # [batch, channels, height, width]
                
                # 解析输入尺寸
                # ONNX 格式：[batch, channels, height, width]
                # 例如：['batch', 3, 384, 288] => 288 (width) x 384 (height)
                # 注意：input_shape 中可能包含字符串（如 'batch'），需要转换
                self.input_height = int(input_shape[2]) if not isinstance(input_shape[2], str) else 384
                self.input_width = int(input_shape[3]) if not isinstance(input_shape[3], str) else 288
                
                # 获取输出信息
                self.output_names = [output.name for output in self.session.get_outputs()]
                
                # 从输出形状推断关键点数量
                # simcc_x 的形状: [batch, num_keypoints, simcc_width]
                # simcc_y 的形状: [batch, num_keypoints, simcc_height]
                output_shape_x = self.session.get_outputs()[0].shape
                # 注意：ONNX 动态维度可能是字符串，需要处理
                num_kpts_raw = output_shape_x[1]
                if isinstance(num_kpts_raw, (int, np.integer)):
                    self.num_keypoints = int(num_kpts_raw)
                else:
                    # 动态维度，使用 RTMW-x 的默认值 133
                    self.num_keypoints = 133
                    logger.warning(f'⚠️ ONNX 关键点维度为动态值 ({num_kpts_raw})，使用默认值 133')
                
                # 归一化参数（RTMW 标准，可从 pipeline.json 验证）
                self.mean = np.array([123.675, 116.28, 103.53], dtype=np.float32)
                self.std = np.array([58.395, 57.12, 57.375], dtype=np.float32)
                
                logger.info(f'✅ RTMW-x 姿态估计器初始化完成')
                logger.info(f'   - 输入形状: [batch, 3, {self.input_height}, {self.input_width}]')
                logger.info(f'   - 输入尺寸: {self.input_width}x{self.input_height} (width×height)')
                logger.info(f'   - 关键点数: {self.num_keypoints}')
                logger.info(f'   - 输入名称: {self.input_name}')
                logger.info(f'   - 输出名称: {self.output_names}')
            else:
                logger.warning('⚠️ RTMW-x 模型未加载（可选功能）')
                
        except Exception as e:
            logger.error(f'RTMW-x 初始化失败: {e}', exc_info=True)
            self.session = None
    
    def estimate_pose(self, image, bbox):
        """
        对检测框进行姿态估计
        
        Args:
            image: 原始图像 (BGR, numpy array)
            bbox: 检测框 [x1, y1, x2, y2]
        
        Returns:
            dict: {
                'valid_joints_ratio': float,  # 有效关键点比例 (0-1)
                'pose_score': float,          # 姿态平均置信度 (0-1)
                'keypoints': list,            # 关键点列表 [[x, y, conf], ...]
                'is_valid_person': bool       # 是否通过姿态验证
            }
        """
        if not self.session:
            logger.warning('RTMW-x 模型未加载，跳过姿态估计')
            return {
                'valid_joints_ratio': 0.0,
                'pose_score': 0.0,
                'keypoints': [],
                'is_valid_person': False
            }
        
        try:
            # 1. 预处理：裁剪和仿射变换
            input_tensor = self._preprocess(image, bbox)
            
            # 2. ONNX 推理
            outputs = self.session.run(self.output_names, {self.input_name: input_tensor})
            
            # 3. 后处理：解码 SimCC 输出
            keypoints = self._decode_simcc(outputs)
            
            # 4. 计算姿态质量
            result = self._evaluate_pose_quality(keypoints)
            
            return result
            
        except Exception as e:
            logger.error(f'姿态估计失败（不影响基础服务）: {e}', exc_info=True)
            return {
                'valid_joints_ratio': 0.0,
                'pose_score': 0.0,
                'keypoints': [],
                'is_valid_person': False
            }
    
    def _preprocess(self, image, bbox):
        """
        预处理：仿射变换将检测框区域对齐到模型输入尺寸
        
        Args:
            image: 原始图像
            bbox: [x1, y1, x2, y2]
        
        Returns:
            numpy.ndarray: shape (1, 3, 256, 192)
        """
        x1, y1, x2, y2 = bbox
        
        # 1. 计算检测框的中心和尺寸
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        bbox_width = x2 - x1
        bbox_height = y2 - y1
        
        # 2. 扩展框（留出更多上下文）
        scale = max(bbox_width, bbox_height) * settings.POSE_BBOX_PADDING
        
        # 3. 仿射变换矩阵
        # 将检测框区域变换到 192x256 的标准尺寸
        transform_matrix = self._get_affine_transform(
            center=(center_x, center_y),
            scale=scale,
            output_size=(self.input_width, self.input_height)
        )
        
        # 4. 应用仿射变换
        warped_img = cv2.warpAffine(
            image,
            transform_matrix,
            (self.input_width, self.input_height),
            flags=cv2.INTER_LINEAR
        )
        
        # 5. 归一化（减均值，除标准差）
        warped_img = warped_img.astype(np.float32)
        warped_img = (warped_img - self.mean) / self.std
        
        # 6. 转换为 CHW 格式并添加 batch 维度
        # (H, W, C) -> (C, H, W) -> (1, C, H, W)
        input_tensor = warped_img.transpose(2, 0, 1)[np.newaxis, ...]
        
        return input_tensor.astype(np.float32)
    
    def _get_affine_transform(self, center, scale, output_size):
        """
        计算仿射变换矩阵
        
        将检测框中心区域变换到目标尺寸
        """
        center_x, center_y = center
        dst_w, dst_h = output_size
        
        # 源图像的3个点（检测框中心及周围）
        src = np.array([
            [center_x, center_y],                           # 中心点
            [center_x, center_y - scale / 2],               # 上方点
            [center_x - scale / 2, center_y]                # 左侧点
        ], dtype=np.float32)
        
        # 目标图像的3个点（标准位置）
        dst = np.array([
            [dst_w / 2, dst_h / 2],                         # 中心点
            [dst_w / 2, dst_h / 2 - dst_h / 2],             # 上方点
            [dst_w / 2 - dst_w / 2, dst_h / 2]              # 左侧点
        ], dtype=np.float32)
        
        # 计算仿射变换矩阵
        transform_matrix = cv2.getAffineTransform(src, dst)
        return transform_matrix
    
    def _decode_simcc(self, outputs):
        """
        解码 SimCC 输出为关键点坐标
        
        SimCC（Simple Coordinate Classification）：
        - 将每个关键点的 x、y 坐标分别作为分类问题
        - simcc_x: (batch, num_keypoints, simcc_width)  - 每个关键点在 x 轴的概率分布
        - simcc_y: (batch, num_keypoints, simcc_height) - 每个关键点在 y 轴的概率分布
        
        注意：simcc 的输出尺寸可能与输入尺寸不同（取决于 simcc_split_ratio）
        
        Args:
            outputs: [simcc_x, simcc_y]
        
        Returns:
            list: [[x, y, confidence], ...] 关键点列表
        """
        simcc_x = outputs[0][0]  # 移除 batch 维度，shape: (num_keypoints, simcc_width)
        simcc_y = outputs[1][0]  # 移除 batch 维度，shape: (num_keypoints, simcc_height)
        
        # 获取 SimCC 输出的实际尺寸（可能与输入尺寸不同）
        simcc_width = simcc_x.shape[1]   # 实际输出宽度
        simcc_height = simcc_y.shape[1]  # 实际输出高度
        
        keypoints = []
        
        for i in range(self.num_keypoints):
            # 找到概率最大的位置（argmax）
            x_idx = np.argmax(simcc_x[i])
            y_idx = np.argmax(simcc_y[i])
            
            # 获取对应的置信度（概率最大值）
            x_conf = simcc_x[i][x_idx]
            y_conf = simcc_y[i][y_idx]
            
            # 关键点置信度取 x 和 y 的几何平均
            confidence = np.sqrt(x_conf * y_conf)
            
            # 坐标值（归一化到 0-1）
            # 重要：使用 SimCC 输出的实际尺寸，而不是输入尺寸
            x = x_idx / simcc_width
            y = y_idx / simcc_height
            
            keypoints.append([float(x), float(y), float(confidence)])
        
        return keypoints
    
    def _evaluate_pose_quality(self, keypoints):
        """
        评估姿态质量，判断是否为有效人物
        
        评估指标：
        1. valid_joints_ratio：有效关键点比例
           - 置信度 > 0.3 的关键点占总数的比例
        2. pose_score：关键点平均置信度
        
        判定标准（来自配置）：
        - valid_joints_ratio >= POSE_MIN_VALID_RATIO (默认 0.4)
        - pose_score >= POSE_MIN_SCORE (默认 0.3)
        
        Args:
            keypoints: [[x, y, conf], ...] 133个关键点
        
        Returns:
            dict: 姿态质量评估结果
        """
        # 阈值（从配置获取）
        min_confidence = settings.POSE_KEYPOINT_CONF_THRESHOLD  # 关键点置信度阈值（用于判断关键点是否有效）
        min_valid_ratio = settings.POSE_MIN_VALID_RATIO         # 有效关键点最小比例
        min_pose_score = settings.POSE_MIN_SCORE                # 平均分数最小值
        
        # 统计有效关键点
        valid_count = 0
        total_confidence = 0.0
        
        for kp in keypoints:
            x, y, conf = kp
            if conf > min_confidence:
                valid_count += 1
            total_confidence += conf
        
        # 计算指标
        valid_joints_ratio = valid_count / len(keypoints) if len(keypoints) > 0 else 0.0
        pose_score = total_confidence / len(keypoints) if len(keypoints) > 0 else 0.0
        
        # 判断是否通过验证
        is_valid_person = (valid_joints_ratio >= min_valid_ratio) and (pose_score >= min_pose_score)
        
        # 日志输出
        if is_valid_person:
            logger.info(f'✅ 姿态验证通过: 有效关键点比例={valid_joints_ratio:.2f}, 平均分数={pose_score:.2f}')
        
        return {
            'valid_joints_ratio': float(valid_joints_ratio),
            'pose_score': float(pose_score),
            'keypoints': keypoints,
            'is_valid_person': is_valid_person
        }

