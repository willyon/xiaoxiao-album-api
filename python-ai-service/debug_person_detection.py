#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人体检测详细调试脚本
用于分析 YOLOv11x 检测结果和 NMS 去重过程

使用方法：
python debug_person_detection.py <图片路径>
"""

import sys
import cv2
import numpy as np
from pathlib import Path

# 添加项目路径
sys.path.insert(0, str(Path(__file__).parent))

from services.person_detector import PersonDetector
from logger import logger
from config import settings


def calculate_iou(box1, box2):
    """计算两个框的 IoU"""
    x1_min, y1_min, x1_max, y1_max = box1
    x2_min, y2_min, x2_max, y2_max = box2
    
    # 计算交集区域
    inter_x_min = max(x1_min, x2_min)
    inter_y_min = max(y1_min, y2_min)
    inter_x_max = min(x1_max, x2_max)
    inter_y_max = min(y1_max, y2_max)
    
    if inter_x_min >= inter_x_max or inter_y_min >= inter_y_max:
        return 0.0
    
    inter_area = (inter_x_max - inter_x_min) * (inter_y_max - inter_y_min)
    
    # 计算并集区域
    box1_area = (x1_max - x1_min) * (y1_max - y1_min)
    box2_area = (x2_max - x2_min) * (y2_max - y2_min)
    union_area = box1_area + box2_area - inter_area
    
    return inter_area / union_area if union_area > 0 else 0.0


def analyze_nms_merging(persons, iou_threshold):
    """
    分析 NMS 去重过程，找出哪些框被合并了
    
    Returns:
        kept: 保留的框列表
        merged_groups: 被合并的框分组 {kept_idx: [merged_indices]}
    """
    if len(persons) == 0:
        return [], {}
    
    # 按置信度排序（降序）
    sorted_persons = sorted(enumerate(persons), key=lambda x: x[1]['confidence'], reverse=True)
    
    kept_indices = []
    kept_persons = []
    merged_groups = {}
    
    for idx, person in sorted_persons:
        should_keep = True
        
        # 检查是否与已保留的框重叠过多
        for kept_idx in kept_indices:
            kept_person = persons[kept_idx]
            iou = calculate_iou(person['bbox'], kept_person['bbox'])
            
            if iou >= iou_threshold:
                # 重叠度过高，合并到已有框
                should_keep = False
                if kept_idx not in merged_groups:
                    merged_groups[kept_idx] = []
                merged_groups[kept_idx].append({
                    'idx': idx,
                    'conf': person['confidence'],
                    'bbox': person['bbox'],
                    'iou': iou
                })
                break
        
        if should_keep:
            kept_indices.append(idx)
            kept_persons.append(person)
    
    return kept_persons, merged_groups


def main():
    if len(sys.argv) < 2:
        print("❌ 请提供图片路径")
        print("用法: python debug_person_detection.py <图片路径>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         🔬 人体检测详细调试分析                               ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    
    # 检查文件是否存在
    if not Path(image_path).exists():
        print(f"❌ 文件不存在: {image_path}")
        sys.exit(1)
    
    print(f"📂 图片路径: {image_path}")
    print("")
    
    # 读取图片
    print("📖 正在读取图片...")
    image = cv2.imread(image_path)
    if image is None:
        print(f"❌ 无法读取图片文件")
        sys.exit(1)
    
    height, width = image.shape[:2]
    print(f"   ✅ 图片尺寸: {width} x {height} px")
    print("")
    
    # 显示当前配置
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         ⚙️  当前配置参数                                      ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    print(f"YOLOV11X_CONF_THRESHOLD = {settings.YOLOV11X_CONF_THRESHOLD} (YOLO官方推荐)")
    print(f"PERSON_BOX_MIN_SIZE_RATIO = {settings.PERSON_BOX_MIN_SIZE_RATIO}")
    print(f"PERSON_NMS_IOU_THRESHOLD = {settings.PERSON_NMS_IOU_THRESHOLD} (YOLO官方默认)")
    print("")
    
    # 初始化检测器
    print("🤖 初始化人体检测器...")
    detector = PersonDetector()
    print("")
    
    # 执行检测（这里需要修改 PersonDetector 以返回详细信息）
    # 由于无法修改原有代码，我们需要直接调用内部方法
    print("🔍 开始人体检测...")
    print("")
    
    # 预处理
    input_tensor = detector._preprocess(image)
    
    # ONNX 推理
    outputs = detector.session.run([detector.output_name], {detector.input_name: input_tensor})
    
    # 后处理 - 使用标准阈值获取所有候选框
    all_candidates = detector._postprocess(outputs, image.shape, conf_threshold=settings.YOLOV11X_CONF_THRESHOLD)
    
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         📊 YOLOv11x 检测结果                                  ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    print(f"检测到候选框: {len(all_candidates)} 个 (conf ≥ {settings.YOLOV11X_CONF_THRESHOLD})")
    print("")
    
    # 输出所有候选框
    if len(all_candidates) > 0:
        print("所有候选框详情:")
        print("-" * 80)
        for i, candidate in enumerate(all_candidates, 1):
            bbox = candidate['bbox']
            conf = candidate['confidence']
            width = bbox[2] - bbox[0]
            height = bbox[3] - bbox[1]
            area = width * height
            print(f"框#{i:2d}: conf={conf:.3f}, bbox=[{bbox[0]:4.0f}, {bbox[1]:4.0f}, {bbox[2]:4.0f}, {bbox[3]:4.0f}], "
                  f"size={width:4.0f}x{height:4.0f}, area={area:7.0f}px²")
        print("")
    
    # 尺寸过滤
    img_short_side = min(image.shape[0], image.shape[1])
    min_box_size = int(img_short_side * settings.PERSON_BOX_MIN_SIZE_RATIO)
    
    size_filtered = []
    for candidate in all_candidates:
        bbox = candidate['bbox']
        box_width = bbox[2] - bbox[0]
        box_height = bbox[3] - bbox[1]
        box_short_side = min(box_width, box_height)
        
        if box_short_side >= min_box_size:
            size_filtered.append(candidate)
    
    print(f"尺寸过滤: 保留 {len(size_filtered)} 个框 (短边 ≥ {min_box_size}px)")
    print("")
    
    # 使用过滤后的框进行NMS（标准做法）
    candidates_for_nms = size_filtered
    
    # NMS 分析
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         🔄 NMS 去重分析                                       ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    
    # 执行NMS并分析
    kept_persons, merged_groups = analyze_nms_merging(candidates_for_nms, settings.PERSON_NMS_IOU_THRESHOLD)
    
    print(f"NMS 参数: IoU 阈值 = {settings.PERSON_NMS_IOU_THRESHOLD} (YOLO官方默认)")
    print(f"NMS 前: {len(candidates_for_nms)} 个框")
    print(f"NMS 后: {len(kept_persons)} 个框")
    print(f"被合并: {len(candidates_for_nms) - len(kept_persons)} 个框")
    print("")
    
    # 显示最终保留的框
    if len(kept_persons) > 0:
        print("最终保留的框:")
        print("-" * 80)
        for i, person in enumerate(kept_persons, 1):
            bbox = person['bbox']
            conf = person['confidence']
            width = bbox[2] - bbox[0]
            height = bbox[3] - bbox[1]
            print(f"人物#{i}: conf={conf:.3f}, bbox=[{bbox[0]:4.0f}, {bbox[1]:4.0f}, {bbox[2]:4.0f}, {bbox[3]:4.0f}], "
                  f"size={width:4.0f}x{height:4.0f}")
        print("")
    
    # 显示被合并的框
    if merged_groups:
        print("被合并的框详情:")
        print("-" * 80)
        for kept_idx, merged_list in merged_groups.items():
            kept_person = candidates_for_nms[kept_idx]
            print(f"\n保留框 (索引{kept_idx}): conf={kept_person['confidence']:.3f}, bbox={kept_person['bbox']}")
            print(f"  合并了 {len(merged_list)} 个框:")
            for merged in merged_list:
                print(f"    - 索引{merged['idx']}: conf={merged['conf']:.3f}, bbox={merged['bbox']}, IoU={merged['iou']:.3f}")
        print("")
    
    # IoU 矩阵分析（显示前10个框之间的IoU）
    if len(candidates_for_nms) > 1:
        print("╔═══════════════════════════════════════════════════════════════╗")
        print("║         📐 IoU 矩阵分析（前10个框）                           ║")
        print("╚═══════════════════════════════════════════════════════════════╝")
        print("")
        
        num_to_show = min(10, len(candidates_for_nms))
        
        # 打印表头
        print("      ", end="")
        for j in range(num_to_show):
            print(f"  框{j+1:2d} ", end="")
        print("")
        print("      " + "-" * (num_to_show * 7))
        
        # 打印IoU矩阵
        for i in range(num_to_show):
            print(f"框{i+1:2d} |", end="")
            for j in range(num_to_show):
                if i == j:
                    print("  1.00 ", end="")
                else:
                    iou = calculate_iou(candidates_for_nms[i]['bbox'], candidates_for_nms[j]['bbox'])
                    print(f" {iou:5.2f} ", end="")
            print(f"  (conf={candidates_for_nms[i]['confidence']:.3f})")
        print("")
        
        # 找出IoU最高的几对框
        print("IoU 最高的框对（可能是重复检测）:")
        iou_pairs = []
        for i in range(len(candidates_for_nms)):
            for j in range(i+1, len(candidates_for_nms)):
                iou = calculate_iou(candidates_for_nms[i]['bbox'], candidates_for_nms[j]['bbox'])
                if iou > 0.1:  # 只显示有明显重叠的
                    iou_pairs.append((i, j, iou))
        
        # 按IoU降序排序
        iou_pairs.sort(key=lambda x: x[2], reverse=True)
        
        for i, j, iou in iou_pairs[:15]:  # 显示前15对
            status = "✅ 去重" if iou >= settings.PERSON_NMS_IOU_THRESHOLD else "⏭️  保留"
            print(f"  框{i+1:2d} <-> 框{j+1:2d}: IoU={iou:.3f} {status}")
        print("")
    
    # 总结和建议
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         💡 分析总结与建议                                     ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    
    final_count = len(kept_persons)
    merged_count = len(candidates_for_nms) - final_count
    
    print(f"【检测结果】")
    print(f"  初始检测: {len(all_candidates)} 个候选框 (conf≥{settings.YOLOV11X_CONF_THRESHOLD})")
    print(f"  尺寸过滤后: {len(size_filtered)} 个")
    print(f"  NMS去重后: {final_count} 个最终人物")
    print("")
    
    print(f"【合并情况】")
    print(f"  被NMS合并掉: {merged_count} 个框")
    if final_count > 0:
        print(f"  平均每个最终人物对应: {len(candidates_for_nms)/final_count:.1f} 个原始框")
    print("")
    
    if merged_count > final_count * 2:
        print(f"【结论】")
        print(f"  ⚠️  大量重复检测！每个人被检测出 {len(candidates_for_nms)/final_count:.1f} 个框")
        print(f"  💡 这是正常的，YOLOv11x会对同一人产生多个框")
        print(f"  💡 NMS的作用就是去除这些重复框")
        print("")
        print(f"【分析】")
        print(f"  查看上面的IoU矩阵和框对列表：")
        print(f"  - IoU接近1.0的框对：同一人的重复检测（应该去重）")
        print(f"  - IoU在0.20-0.45之间：可能是靠近的不同人物（应该保留）")
        print(f"  - IoU < 0.20：明显不同的人（肯定保留）")
        print("")
        print(f"【优化建议】")
        if final_count < 3:
            print(f"  如果实际有3个人，检查IoU矩阵中是否有0.30-0.45之间的框对")
            print(f"  这些可能是中间的宝宝，但被误合并了")
            print(f"  可尝试：提高 PERSON_NMS_IOU_THRESHOLD 到 0.50-0.55")
    else:
        print(f"【结论】")
        print(f"  ✅ NMS去重适度")
        print(f"  如果检测人数不对，问题可能在于：")
        print(f"  1. 置信度阈值过高，小目标被过滤")
        print(f"  2. 尺寸过滤太严格，远景人物被过滤")
    print("")


if __name__ == '__main__':
    main()

