#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
导出 YOLOv11 为 ONNX 格式
升级到最新的 YOLO 模型
"""

import os
import sys

print("\n" + "="*60)
print("YOLOv11 导出为 ONNX 格式")
print("="*60 + "\n")

try:
    print("📦 导入 ultralytics...")
    from ultralytics import YOLO
    print("✅ ultralytics 已导入\n")
    
    # YOLOv11 模型大小选择
    # yolo11n: nano（最快，准确性最低）
    # yolo11s: small（推荐，速度和准确性平衡）
    # yolo11m: medium（准确性更高，速度适中）
    # yolo11l: large（准确性很高，速度较慢）
    # yolo11x: extra large（准确性最高，速度最慢）
    
    model_name = 'yolo11x'  # 使用 extra large 版本（准确性最高）
    
    print(f"📥 下载并加载 {model_name}.pt...")
    print("   （首次运行会从网络下载模型，可能需要几分钟）")
    model = YOLO(f'{model_name}.pt')
    print(f"✅ 模型已加载\n")
    
    print("🔄 导出为 ONNX 格式...")
    print("   参数设置:")
    print("   - format='onnx'")
    print("   - imgsz=640 (输入尺寸)")
    print("   - simplify=True (简化 ONNX 图)")
    print("   - opset=12 (ONNX 算子版本)")
    print()
    
    # 导出为 ONNX
    success = model.export(
        format='onnx',
        imgsz=640,          # 输入图像尺寸
        simplify=True,      # 简化 ONNX 图（提升性能）
        opset=12            # ONNX 算子版本（兼容性好）
    )
    
    if success:
        onnx_path = f'{model_name}.onnx'
        file_size = os.path.getsize(onnx_path) / (1024 * 1024)
        
        print(f"\n✅ 导出成功！")
        print(f"   文件: {onnx_path}")
        print(f"   大小: {file_size:.2f} MB")
        print()
        
        # 移动到 models 目录（保持原文件名 yolo11x.onnx）
        target_dir = "models"
        target_path = os.path.join(target_dir, "yolo11x.onnx")
        
        os.makedirs(target_dir, exist_ok=True)
        
        import shutil
        shutil.move(onnx_path, target_path)
        
        print(f"📁 已移动到: {target_path}")
        print(f"   （文件名: yolo11x.onnx，需更新代码配置）")
        print()
        
        print("="*60)
        print("🎉 YOLOv11 导出完成！")
        print("="*60)
        print()
        print("📝 下一步:")
        print("   1. 重启 Python AI 服务")
        print("   2. 测试检测效果")
        print("   3. 如果效果不理想，可以恢复备份:")
        print("      mv models/yolov10s.onnx.backup models/yolov10s.onnx")
        print()
        print("💡 提示:")
        print("   - 当前使用: yolo11s (small)")
        print("   - 如需更高准确性，可改用: yolo11m (medium)")
        print("   - 修改脚本第26行的 model_name")
        print()
        
    else:
        print("❌ 导出失败")
        sys.exit(1)
        
except ImportError:
    print("❌ ultralytics 未安装或版本过旧")
    print()
    print("请升级到最新版: pip install --upgrade ultralytics")
    print("然后重新运行此脚本")
    sys.exit(1)
    
except Exception as e:
    print(f"\n❌ 导出失败: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

