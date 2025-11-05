#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸检测详细调试脚本
分析 InsightFace 检测结果和质量过滤过程

使用方法：
python debug_face_detection.py <图片路径>
"""

import sys
import cv2
from pathlib import Path

# 添加项目路径
sys.path.insert(0, str(Path(__file__).parent))

from services.face_detector import FaceDetector
from logger import logger
from config import settings


def main():
    if len(sys.argv) < 2:
        print("❌ 请提供图片路径")
        print("用法: python debug_face_detection.py <图片路径>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         🔬 人脸检测详细调试分析                               ║")
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
    print(f"FACE_DET_SIZE = {settings.FACE_DET_SIZE}")
    print(f"MIN_FACE_SIZE = {settings.MIN_FACE_SIZE}px")
    print(f"MIN_QUALITY_SCORE = {settings.MIN_QUALITY_SCORE}")
    print(f"MAX_YAW_ANGLE = {settings.MAX_YAW_ANGLE}°")
    print(f"MAX_PITCH_ANGLE = {settings.MAX_PITCH_ANGLE}°")
    print("")
    
    # 初始化检测器
    print("🤖 初始化人脸检测器...")
    detector = FaceDetector()
    print("")
    
    # 执行检测
    print("🔍 开始人脸检测...")
    print("")
    
    result = detector.detect(image)
    all_faces = result['all_faces']
    all_faces_count = result['all_faces_count']
    
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         📊 InsightFace 检测结果                               ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    print(f"检测到人脸总数: {all_faces_count}")
    print("")
    
    if all_faces_count == 0:
        print("❌ 未检测到任何人脸")
        print("")
        print("可能原因：")
        print("  1. 图片中确实没有正面人脸")
        print("  2. 所有人脸都被遮挡或角度太侧")
        print("  3. 人脸太小（< 12px在检测尺寸下）")
        return
    
    # 分析每张人脸
    print("所有检测到的人脸详情:")
    print("=" * 80)
    
    passed_faces = []
    filtered_faces = []
    
    for i, face in enumerate(all_faces, 1):
        print(f"\n人脸 #{i}:")
        print(f"  📏 尺寸: {face['face_size']}px")
        print(f"  📊 质量分数: {face['quality_score']:.3f}")
        print(f"  📐 姿态:")
        print(f"     偏航角(yaw): {face['pose']['yaw']:.1f}°")
        print(f"     俯仰角(pitch): {face['pose']['pitch']:.1f}°")
        print(f"     翻滚角(roll): {face['pose']['roll']:.1f}°")
        print(f"  📍 边界框: {face['bbox']}")
        
        # 判断是否通过质量检查
        passed = face.get('passed_quality', False)
        
        if passed:
            print(f"  ✅ 通过质量检查")
            passed_faces.append(face)
        else:
            print(f"  ❌ 未通过质量检查")
            filtered_faces.append(face)
            
            # 详细说明未通过原因
            reasons = []
            if face['face_size'] < settings.MIN_FACE_SIZE:
                reasons.append(f"尺寸{face['face_size']}px < {settings.MIN_FACE_SIZE}px")
            if face['quality_score'] < settings.MIN_QUALITY_SCORE:
                reasons.append(f"质量{face['quality_score']:.2f} < {settings.MIN_QUALITY_SCORE}")
            if abs(face['pose']['yaw']) > settings.MAX_YAW_ANGLE:
                reasons.append(f"|偏航角|={abs(face['pose']['yaw']):.1f}° > {settings.MAX_YAW_ANGLE}°")
            if abs(face['pose']['pitch']) > settings.MAX_PITCH_ANGLE:
                reasons.append(f"|俯仰角|={abs(face['pose']['pitch']):.1f}° > {settings.MAX_PITCH_ANGLE}°")
            
            print(f"     原因: {', '.join(reasons)}")
    
    # 总结
    print("\n" + "=" * 80)
    print("")
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         📊 过滤统计                                           ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print("")
    print(f"检测到的人脸总数: {all_faces_count}")
    print(f"通过质量检查: {len(passed_faces)} 张 ✅")
    print(f"被过滤掉: {len(filtered_faces)} 张 ❌")
    print("")
    
    if filtered_faces:
        print("被过滤人脸的原因汇总:")
        for i, face in enumerate(filtered_faces, 1):
            reasons = []
            if face['face_size'] < settings.MIN_FACE_SIZE:
                reasons.append(f"尺寸不足({face['face_size']}px)")
            if face['quality_score'] < settings.MIN_QUALITY_SCORE:
                reasons.append(f"质量过低({face['quality_score']:.2f})")
            if abs(face['pose']['yaw']) > settings.MAX_YAW_ANGLE:
                reasons.append(f"侧脸过大({abs(face['pose']['yaw']):.1f}°)")
            if abs(face['pose']['pitch']) > settings.MAX_PITCH_ANGLE:
                reasons.append(f"俯仰过大({abs(face['pose']['pitch']):.1f}°)")
            
            print(f"  人脸#{face['face_index']+1}: {', '.join(reasons)}")
        print("")
    
    # 优化建议
    if filtered_faces:
        print("╔═══════════════════════════════════════════════════════════════╗")
        print("║         💡 优化建议                                           ║")
        print("╚═══════════════════════════════════════════════════════════════╝")
        print("")
        
        # 分析主要过滤原因
        size_filtered = sum(1 for f in filtered_faces if f['face_size'] < settings.MIN_FACE_SIZE)
        quality_filtered = sum(1 for f in filtered_faces if f['quality_score'] < settings.MIN_QUALITY_SCORE)
        yaw_filtered = sum(1 for f in filtered_faces if abs(f['pose']['yaw']) > settings.MAX_YAW_ANGLE)
        pitch_filtered = sum(1 for f in filtered_faces if abs(f['pose']['pitch']) > settings.MAX_PITCH_ANGLE)
        
        if size_filtered > 0:
            min_size = min(f['face_size'] for f in filtered_faces)
            print(f"  • 有 {size_filtered} 张人脸因尺寸被过滤（最小{min_size}px）")
            print(f"    建议：降低 MIN_FACE_SIZE 到 {int(min_size * 0.9)}px")
        
        if quality_filtered > 0:
            min_quality = min(f['quality_score'] for f in filtered_faces)
            print(f"  • 有 {quality_filtered} 张人脸因质量被过滤（最低{min_quality:.2f}）")
            print(f"    建议：降低 MIN_QUALITY_SCORE 到 {min_quality * 0.9:.2f}")
        
        if yaw_filtered > 0:
            max_yaw = max(abs(f['pose']['yaw']) for f in filtered_faces)
            print(f"  • 有 {yaw_filtered} 张人脸因偏航角被过滤（最大{max_yaw:.1f}°）")
            print(f"    建议：提高 MAX_YAW_ANGLE 到 {int(max_yaw * 1.1)}°")
        
        if pitch_filtered > 0:
            max_pitch = max(abs(f['pose']['pitch']) for f in filtered_faces)
            print(f"  • 有 {pitch_filtered} 张人脸因俯仰角被过滤（最大{max_pitch:.1f}°）")
            print(f"    建议：提高 MAX_PITCH_ANGLE 到 {int(max_pitch * 1.1)}°")
        
        print("")


if __name__ == '__main__':
    main()

