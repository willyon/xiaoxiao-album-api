#!/usr/bin/env python3
"""
RTMPose ONNX 模型下载脚本

模型信息：
- 模型：RTMPose-m (Middle) - 精度与速度平衡
- 骨架格式：COCO 17 关键点
- 输入尺寸：256x192
- 用途：对 YOLOv10 低置信度检测框进行姿态验证
"""

import os
import urllib.request
from pathlib import Path

def download_rtmpose_onnx():
    """
    下载 RTMPose-m ONNX 模型
    
    模型来源：MMPose 官方 Model Zoo
    链接：https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose
    """
    
    # RTMPose-m ONNX 模型下载地址
    # 使用 RTMPose-m (COCO 数据集，17个关键点)
    model_url = "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.onnx"
    
    model_dir = Path("models")
    model_dir.mkdir(exist_ok=True)
    
    model_path = model_dir / "rtmpose-m.onnx"
    
    if model_path.exists():
        print(f"✅ RTMPose 模型已存在: {model_path}")
        print(f"📦 文件大小: {model_path.stat().st_size / 1024 / 1024:.2f} MB")
        return
    
    print(f"🚀 开始下载 RTMPose-m ONNX 模型...")
    print(f"📥 下载地址: {model_url}")
    print(f"📂 保存路径: {model_path}")
    
    try:
        # 下载模型
        urllib.request.urlretrieve(model_url, model_path)
        
        file_size_mb = model_path.stat().st_size / 1024 / 1024
        print(f"\n✅ RTMPose-m ONNX 模型下载完成！")
        print(f"📦 文件大小: {file_size_mb:.2f} MB")
        print(f"📂 保存位置: {model_path}")
        print(f"\n🎯 模型信息:")
        print(f"   - 输入尺寸: 256x192")
        print(f"   - 关键点数: 17 (COCO格式)")
        print(f"   - 用途: 姿态验证，提升人物检测召回率")
        
    except Exception as e:
        print(f"❌ 下载失败: {e}")
        print(f"\n💡 备用方案:")
        print(f"   1. 手动下载: {model_url}")
        print(f"   2. 保存到: {model_path}")
        raise

if __name__ == "__main__":
    download_rtmpose_onnx()

