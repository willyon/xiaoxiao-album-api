#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
导出 YOLOv10 为 ONNX 格式
一次性脚本，导出后即可删除
"""

import os
import sys

print("\n" + "="*60)
print("YOLOv10 导出为 ONNX 格式")
print("="*60 + "\n")

try:
    print("📦 导入 ultralytics...")
    from ultralytics import YOLO
    print("✅ ultralytics 已导入\n")
    
    # 选择模型大小
    model_name = 'yolov10s'  # s=small（推荐），n=nano（更快），m=medium（更准）
    
    print(f"📥 下载并加载 {model_name}.pt...")
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
        
        # 移动到 models/managed/object 目录
        target_dir = os.path.join("models", "managed", "object")
        target_path = os.path.join(target_dir, "yolov10s.onnx")
        
        os.makedirs(target_dir, exist_ok=True)
        
        import shutil
        shutil.move(onnx_path, target_path)
        
        print(f"📁 已移动到: {target_path}")
        print()
        
        print("="*60)
        print("🎉 完成！")
        print("="*60)
        print()
        print("📝 下一步:")
        print("   1. 修改 model_loader.py 使用 ONNX 格式")
        print("   2. 重启 Python AI 服务")
        print("   3. 可选：卸载 ultralytics (pip uninstall ultralytics)")
        print()
        
    else:
        print("❌ 导出失败")
        sys.exit(1)
        
except ImportError:
    print("❌ ultralytics 未安装")
    print()
    print("请先安装: pip install ultralytics")
    print("然后重新运行此脚本")
    sys.exit(1)
    
except Exception as e:
    print(f"\n❌ 导出失败: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

