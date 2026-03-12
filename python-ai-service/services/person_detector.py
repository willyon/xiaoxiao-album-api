#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人体检测器 - 与物体检测共用同一 YOLO 实例

功能：
• 通过 ModelManager.get_object_model(profile, device) 获取 YoloObjectDetector
• 复用同一 ONNX 会话做人体检测（仅保留 class_id=0 person）
• 人体专用：尺寸过滤、NMS 参数与人物分析一致（YOLOV11X_CONF_THRESHOLD、PERSON_BOX_MIN_SIZE_RATIO、PERSON_NMS_IOU_THRESHOLD）
"""

import numpy as np
from logger import logger
from config import settings


class PersonDetector:
    """
    人体检测器 - 与 object 共用同一 YOLO 实例

    通过 ModelManager 获取 YoloObjectDetector，对 detect() 结果只保留 person 类，
    再做人休专用的尺寸过滤与 NMS。
    """

    def __init__(self, model_manager=None, profile: str = "standard", device: str = "cpu"):
        """
        profile/device 用于从 ModelManager 取与 object 一致的 YOLO 实例。
        不在此处加载模型，首次 detect() 时再按需获取并复用。
        """
        self._manager = model_manager  # 若为 None，detect() 内通过 get_model_manager() 获取
        self._profile = profile or "standard"
        self._device = device or "cpu"
        logger.info(
            "✅ PersonDetector 初始化完成（与 object 共用 YOLO，profile=%s）",
            self._profile,
        )

    def _get_object_detector(self):
        """获取与物体检测共用的 YOLO 检测器实例。"""
        if self._manager is not None:
            return self._manager.get_object_model(self._profile, self._device)
        from services.model_manager import get_model_manager
        return get_model_manager().get_object_model(self._profile, self._device)

    def detect(self, image):
        """
        检测图片中的所有人物（person 类）。

        使用与物体检测相同的 YOLO 实例，只保留 label=="person" 的框，
        再做人休专用尺寸过滤与 NMS。
        """
        detector = self._get_object_detector()
        if detector is None or getattr(detector, "session", None) is None:
            logger.warning("PersonDetector: 未获取到 YOLO 检测器，返回 person_count=0")
            return {"person_count": 0, "persons": []}

        if image is None or image.size == 0:
            return {"person_count": 0, "persons": []}

        try:
            # 复用 object 的 detect，得到全部类别
            all_detections = detector.detect(image)
            person_candidates = [
                d for d in all_detections
                if d.get("label") == "person"
            ]

            # 为尺寸过滤补充 short_side
            for p in person_candidates:
                bbox = p.get("bbox", [0, 0, 0, 0])
                w = bbox[2] - bbox[0]
                h = bbox[3] - bbox[1]
                p["size"] = int(min(w, h))

            img_h, img_w = image.shape[:2]
            img_short_side = min(img_h, img_w)
            min_box_size = int(img_short_side * getattr(settings, "PERSON_BOX_MIN_SIZE_RATIO", 0.05))
            filtered = self._filter_by_size(person_candidates, min_box_size)
            final_persons = self._nms(filtered, iou_threshold=getattr(settings, "PERSON_NMS_IOU_THRESHOLD", 0.40))

            return {
                "person_count": len(final_persons),
                "persons": final_persons,
            }
        except Exception as e:
            logger.error("人体检测失败（不影响基础服务）: %s", e, exc_info=True)
            return {"person_count": 0, "persons": []}

    def _filter_by_size(self, persons, min_box_size):
        """过滤掉尺寸过小的人体框（远景小人）。"""
        if not persons or min_box_size <= 0:
            return persons
        return [p for p in persons if p.get("size", 0) >= min_box_size]

    def _nms(self, persons, iou_threshold=0.40):
        """人体框 NMS（同一类内去重）。"""
        if not persons:
            return []
        persons_sorted = sorted(persons, key=lambda x: x.get("confidence", 0.0), reverse=True)
        kept = []
        for p in persons_sorted:
            keep = True
            for kp in kept:
                if self._iou(p["bbox"], kp["bbox"]) >= iou_threshold:
                    keep = False
                    break
            if keep:
                kept.append(p)
        return kept

    @staticmethod
    def _iou(box_a, box_b):
        """计算两个框的 IoU。box: [x1, y1, x2, y2]"""
        xA = max(box_a[0], box_b[0])
        yA = max(box_a[1], box_b[1])
        xB = min(box_a[2], box_b[2])
        yB = min(box_a[3], box_b[3])
        inter_w = max(0, xB - xA)
        inter_h = max(0, yB - yA)
        inter_area = inter_w * inter_h
        area_a = max(0, box_a[2] - box_a[0]) * max(0, box_a[3] - box_a[1])
        area_b = max(0, box_b[2] - box_b[0]) * max(0, box_b[3] - box_b[1])
        union = area_a + area_b - inter_area
        return inter_area / union if union > 0 else 0.0
