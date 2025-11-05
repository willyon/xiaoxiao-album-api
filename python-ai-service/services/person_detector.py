#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人体检测器 - 基于 YOLOv11x ONNX

功能：
• 使用 YOLOv11x 进行人体检测
• 高置信度阈值（>= 0.50）确保检测准确性

优势：
• 使用 ONNX Runtime 推理（比 PyTorch 快 20-40%）
• 不依赖 ultralytics 库（减少依赖）
• 与现有架构一致（FairFace、EmotiEffLib 都用 ONNX）
"""

import cv2
import numpy as np
from logger import logger
from config import settings
from loaders.model_loader import get_yolov11x_session


class PersonDetector:
    """
    人体检测器 - 基于 YOLOv11x ONNX
    
    使用 YOLOv11x 进行高精度人体检测
    """
    
    def __init__(self):
        """
        初始化人体检测器
        
        功能说明：
        1. 从 model_loader 获取预加载的 YOLOv11x ONNX session
        2. 初始化姿态估计器（用于二次验证）
        """
        try:
            # 从 loader 获取已加载的 ONNX session
            self.session = get_yolov11x_session()
            
            if self.session:
                # 获取输入输出名称（ONNX模型在导出时定义的标识符）
                # 不同模型的名称可能不同，需要从模型元数据中获取
                # 例如：YOLOv11x 使用 'images' 和 'output0'，FairFace 使用 'input' 和 ['race_id', 'gender_id', 'age_id']
                self.input_name = self.session.get_inputs()[0].name  # YOLOv11x: 'images'
                self.output_name = self.session.get_outputs()[0].name  # YOLOv11x: 'output0'
                
                # 获取输入尺寸
                # ONNX shape格式: [batch, channels, height, width] = [1, 3, 640, 640]
                input_shape = self.session.get_inputs()[0].shape
                input_height = int(input_shape[2])  # 640
                input_width = int(input_shape[3])    # 640
                
                # cv2.resize 需要 (width, height) 格式
                self.input_size = (input_width, input_height)  # (640, 640)
                self.input_height = input_height
                self.input_width = input_width
                
                logger.info(f'✅ YOLOv11x ONNX 人体检测器初始化完成')
                logger.info(f'   - 输入名称: {self.input_name}')
                logger.info(f'   - 输出名称: {self.output_name}')
                logger.info(f'   - 输入尺寸: {self.input_width}x{self.input_height}')
            else:
                logger.warning('⚠️ YOLOv11x ONNX 模型未加载')
            
        except Exception as e:
            logger.error(f'YOLOv11x 初始化失败: {e}', exc_info=True)
            self.session = None
    
    def detect(self, image):
        """
        检测图片中的所有人物（YOLO 标准做法）
        
        检测流程：
        1. YOLOv11x ONNX 推理
        2. 后处理：解析检测框（conf ≥ 0.25，YOLO官方推荐）
        3. 尺寸过滤：过滤远景小人
        4. NMS去重：去除重复检测框（IoU ≥ 0.45，YOLO官方默认）
        
        Args:
            image: OpenCV 格式的图片 (numpy array, BGR)
        
        Returns:
            dict: {
                'person_count': int - 人体检测的人数
                'persons': list[dict] - 每个人的信息
            }
        """
        if not self.session:
            logger.warning('YOLOv11x ONNX 模型未加载，返回 person_count=0')
            return {
                'person_count': 0,
                'persons': []
            }
        
        try:
            if image is None or image.size == 0:
                logger.warning('输入图片为空')
                return {
                    'person_count': 0,
                    'persons': []
                }
            
            # ========== YOLOv11x 检测（标准做法）==========
            
            # 1. 图像预处理
            input_tensor = self._preprocess(image)
            
            # 2. ONNX 推理
            # YOLOv11x 输出格式: [1, 84, 8400]
            outputs = self.session.run([self.output_name], {self.input_name: input_tensor})
            
            # 3. 后处理：解析检测框（YOLO官方推荐阈值0.25）
            all_candidates = self._postprocess(outputs, image.shape, conf_threshold=settings.YOLOV11X_CONF_THRESHOLD)
            logger.info(f'YOLOv11x 检测: 共 {len(all_candidates)} 个候选框 (conf≥{settings.YOLOV11X_CONF_THRESHOLD})')
            
            # 打印前10个候选框的详细信息（调试用）
            for i, cand in enumerate(all_candidates[:10], 1):
                logger.info(f'  候选框{i}: conf={cand["confidence"]:.3f}, bbox={cand["bbox"]}')
            if len(all_candidates) > 10:
                logger.info(f'  ... 还有 {len(all_candidates) - 10} 个框')
            
            # ========== 尺寸过滤：过滤远景小人 ==========
            img_h, img_w = image.shape[:2]
            img_short_side = min(img_h, img_w)
            min_box_size = int(img_short_side * settings.PERSON_BOX_MIN_SIZE_RATIO)
            
            all_candidates = self._filter_by_size(all_candidates, min_box_size)
            logger.info(f'尺寸过滤: 保留 {len(all_candidates)} 个足够大的人体框 (min_size={min_box_size}px)')
            
            # ========== NMS 去重（标准做法）==========
            # 
            # YOLO标准策略：
            # - 所有置信度 ≥ 阈值的框都保留
            # - 通过NMS去除重复检测（IoU ≥ 0.45）
            # 
            # 优势：
            # - 简单有效，经过海量数据验证
            # - 能检测到小目标（儿童、远景人物）
            # - 避免过度过滤导致漏检
            
            final_persons = self._nms(all_candidates, iou_threshold=settings.PERSON_NMS_IOU_THRESHOLD)
            
            removed_count = len(all_candidates) - len(final_persons)
            if removed_count > 0:
                logger.info(f'NMS去重: 移除{removed_count}个重复框 (IoU阈值={settings.PERSON_NMS_IOU_THRESHOLD})')
            
            final_count = len(final_persons)
            
            logger.info(f'✅ 人物检测完成: 总计 {final_count} 人')
            
            # 输出每个最终保留框的详细信息（调试用）
            for i, p in enumerate(final_persons, 1):
                logger.info(f'  框{i}: conf={p["confidence"]:.3f}, bbox={p["bbox"]}, size={p.get("size", 0)}px')
            
            return {
                'person_count': final_count,
                'persons': final_persons
            }
            
        except Exception as e:
            logger.error(f'人体检测失败（不影响基础服务）: {e}', exc_info=True)
            return {
                'person_count': 0,
                'persons': []
            }
    
    def _preprocess(self, image):
        """图像预处理"""
        # 1. 调整尺寸到模型输入尺寸（640x640）
        img = cv2.resize(image, self.input_size)
        
        # 2. BGR → RGB
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        
        # 3. 归一化到 [0, 1]
        img = img.astype(np.float32) / 255.0
        
        # 4. HWC → CHW
        img = np.transpose(img, (2, 0, 1))
        
        # 5. 添加 batch 维度
        img = np.expand_dims(img, axis=0)
        
        return img
    
    def _postprocess(self, outputs, orig_shape, conf_threshold):
        """
        后处理 YOLOv11x 输出
        
        YOLOv11x ONNX 输出格式：
        - outputs[0]: shape=[1, 84, 8400]
        - 84 = 4(坐标) + 80(类别置信度)
        - 8400 = anchor数量（基于640x640输入）
        - 每个anchor: [x_center, y_center, width, height, class0_conf, class1_conf, ..., class79_conf]
        - person类 = class_id=0，置信度在索引4
        - 坐标格式：像素坐标（基于640x640输入尺寸）
        
        注意：
        - YOLOv11x 输出的坐标是基于输入图像尺寸（640x640）的像素坐标
        - 需要缩放回原始图像尺寸
        """
        persons = []
        
        orig_h, orig_w = orig_shape[:2]
        
        # 计算缩放比例（从模型输入尺寸到原始图像尺寸）
        scale_x = orig_w / self.input_width   # 宽度缩放比例
        scale_y = orig_h / self.input_height   # 高度缩放比例
        
        # YOLOv11x 输出格式: [1, 84, 8400]
        # outputs[0] 是第一个（也是唯一的）输出
        predictions = outputs[0][0]  # 移除batch维度: [84, 8400]
        
        # 解析每个anchor
        num_anchors = predictions.shape[1]  # 8400
        for i in range(num_anchors):
            anchor = predictions[:, i]  # [84] - 获取第i个anchor的所有84个值
            
            # 提取坐标（前4个值，基于640x640输入）
            x_center = float(anchor[0])  # 中心x坐标（像素）
            y_center = float(anchor[1])  # 中心y坐标（像素）
            width = float(anchor[2])      # 宽度（像素）
            height = float(anchor[3])    # 高度（像素）
            
            # person类的置信度（索引4，class_id=0）
            conf = float(anchor[4])
            
            # 只保留 person 类且置信度足够的
            if conf >= conf_threshold:
                # 转换为左上角和右下角坐标（基于640x640）
                x1_model = x_center - width / 2
                y1_model = y_center - height / 2
                x2_model = x_center + width / 2
                y2_model = y_center + height / 2
                
                # 坐标缩放到原图尺寸
                x1 = int(x1_model * scale_x)
                y1 = int(y1_model * scale_y)
                x2 = int(x2_model * scale_x)
                y2 = int(y2_model * scale_y)
                
                # 边界检查（确保坐标在图像范围内）
                x1 = max(0, min(x1, orig_w))
                y1 = max(0, min(y1, orig_h))
                x2 = max(0, min(x2, orig_w))
                y2 = max(0, min(y2, orig_h))
                
                # 验证框的有效性（宽高必须大于0）
                if x2 > x1 and y2 > y1:
                    box_width = x2 - x1
                    box_height = y2 - y1
                    box_short_side = min(box_width, box_height)
                    
                    persons.append({
                        'bbox': [x1, y1, x2, y2],
                        'confidence': conf,
                        'size': int(box_short_side)  # 短边尺寸，用于尺寸过滤
                    })
        
        # 按置信度降序排序（高置信度优先）
        persons.sort(key=lambda x: x['confidence'], reverse=True)
        
        return persons
    
    def _filter_by_size(self, persons, min_box_size):
        """
        过滤掉尺寸过小的人体框（远景小人）
        
        参数：
        - persons: 人体检测框列表
        - min_box_size: 人体框短边的最小像素值（过滤远景小人）
        
        返回：
        - 过滤后的人体框列表
        """
        filtered = []
        for p in persons:
            x1, y1, x2, y2 = p['bbox']
            box_w = x2 - x1
            box_h = y2 - y1
            box_short_side = min(box_w, box_h)
            
            # 只过滤过小的框（远景小人）
            if box_short_side >= min_box_size:
                filtered.append(p)
        
        return filtered
    
    def _nms(self, persons, iou_threshold=0.40):
        """
        非极大值抑制（NMS）- 标准IoU策略
        
        策略：
        - IoU >= 阈值（默认0.40）→ 去重
        - IoU < 阈值 → 保留
        
        参数说明：
        - iou_threshold: IoU阈值（默认0.40）
          • IoU >= 阈值: 判定为重复，去重
          • IoU < 阈值: 判定为独立，保留
        
        persons: [{ bbox:[x1,y1,x2,y2], confidence: float }]
        """
        if not persons:
            return []

        # 按置信度降序
        persons_sorted = sorted(persons, key=lambda x: x.get('confidence', 0.0), reverse=True)
        kept = []

        for p in persons_sorted:
            should_keep = True
            for kp in kept:
                # 计算IoU
                iou = self._iou(p['bbox'], kp['bbox'])
                
                # IoU判断
                if iou >= iou_threshold:
                    should_keep = False
                    break
            
            if should_keep:
                kept.append(p)

        return kept

    def _iou(self, boxA, boxB):
        """计算两个框的 IoU。
        box: [x1, y1, x2, y2]
        """
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])

        interW = max(0, xB - xA)
        interH = max(0, yB - yA)
        interArea = interW * interH

        areaA = max(0, (boxA[2] - boxA[0])) * max(0, (boxA[3] - boxA[1]))
        areaB = max(0, (boxB[2] - boxB[0])) * max(0, (boxB[3] - boxB[1]))

        unionArea = areaA + areaB - interArea
        if unionArea <= 0:
            return 0.0
        return interArea / unionArea
