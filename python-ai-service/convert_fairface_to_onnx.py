#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FairFace PyTorch 模型转换为 ONNX 格式

功能：
1. 下载 FairFace 官方 PyTorch 模型
2. 转换为 ONNX 格式
3. 验证 ONNX 模型是否可用
"""

import os
import sys
import urllib.request
from pathlib import Path
import torch
import torch.nn as nn
import torchvision.models as models
import onnx
import onnxruntime as ort
import numpy as np

# 模型配置
PYTORCH_MODEL_URL = "https://github.com/dchen236/FairFace/raw/master/fair_face_models/res34_fair_align_multi_7_20190809.pt"
MODELS_DIR = Path(__file__).parent / "models"
PYTORCH_MODEL_PATH = MODELS_DIR / "fairface_pytorch.pt"
ONNX_MODEL_PATH = MODELS_DIR / "fairface.onnx"

# FairFace 模型架构（ResNet-34）
class FairFaceModel(nn.Module):
    """FairFace 模型架构（基于 ResNet-34）"""
    
    def __init__(self):
        super(FairFaceModel, self).__init__()
        self.model = models.resnet34(pretrained=False)
        # FairFace 的输出层
        # 7 种族 + 2 性别 + 9 年龄段 = 18 个输出
        self.model.fc = nn.Linear(self.model.fc.in_features, 18)
    
    def forward(self, x):
        x = self.model(x)
        # 分割输出
        race_output = x[:, 0:7]   # 种族（7类）
        gender_output = x[:, 7:9]  # 性别（2类）
        age_output = x[:, 9:18]    # 年龄（9类）
        
        # 返回类别索引（argmax）
        race_id = torch.argmax(race_output, dim=1)
        gender_id = torch.argmax(gender_output, dim=1)
        age_id = torch.argmax(age_output, dim=1)
        
        return race_id, gender_id, age_id


def download_pytorch_model():
    """下载 FairFace PyTorch 模型"""
    print(f"📥 下载 FairFace PyTorch 模型...")
    print(f"   URL: {PYTORCH_MODEL_URL}")
    
    if PYTORCH_MODEL_PATH.exists():
        print(f"   ✅ 模型已存在，跳过下载")
        return True
    
    try:
        def show_progress(block_num, block_size, total_size):
            downloaded = block_num * block_size
            if total_size > 0:
                percent = min(downloaded * 100 / total_size, 100)
                size_mb = total_size / (1024 * 1024)
                downloaded_mb = downloaded / (1024 * 1024)
                print(f"\r   进度: {percent:.1f}% ({downloaded_mb:.1f}MB / {size_mb:.1f}MB)", end="")
        
        urllib.request.urlretrieve(PYTORCH_MODEL_URL, PYTORCH_MODEL_PATH, show_progress)
        print()
        print(f"   ✅ 下载完成")
        return True
        
    except Exception as e:
        print(f"\n   ❌ 下载失败: {e}")
        return False


def convert_to_onnx():
    """将 PyTorch 模型转换为 ONNX"""
    print(f"\n🔄 转换模型格式: PyTorch → ONNX...")
    
    try:
        # 1. 加载 PyTorch 模型
        print(f"   📂 加载 PyTorch 模型...")
        model = FairFaceModel()
        state_dict = torch.load(PYTORCH_MODEL_PATH, map_location='cpu')
        model.load_state_dict(state_dict)
        model.eval()
        print(f"   ✅ PyTorch 模型加载成功")
        
        # 2. 创建示例输入（FairFace 使用 224x224 的 RGB 图像）
        print(f"   🎨 创建示例输入 (1, 3, 224, 224)...")
        dummy_input = torch.randn(1, 3, 224, 224)
        
        # 3. 导出为 ONNX
        print(f"   💾 导出为 ONNX 格式...")
        torch.onnx.export(
            model,
            dummy_input,
            ONNX_MODEL_PATH,
            export_params=True,
            opset_version=11,
            do_constant_folding=True,
            input_names=['input'],
            output_names=['race_id', 'gender_id', 'age_id'],
            dynamic_axes={
                'input': {0: 'batch_size'},
                'race_id': {0: 'batch_size'},
                'gender_id': {0: 'batch_size'},
                'age_id': {0: 'batch_size'}
            }
        )
        print(f"   ✅ ONNX 模型导出成功")
        
        return True
        
    except Exception as e:
        print(f"\n   ❌ 转换失败: {e}")
        import traceback
        traceback.print_exc()
        return False


def verify_onnx_model():
    """验证 ONNX 模型"""
    print(f"\n✅ 验证 ONNX 模型...")
    
    try:
        # 1. 加载模型
        print(f"   📂 加载 ONNX 模型...")
        session = ort.InferenceSession(str(ONNX_MODEL_PATH))
        print(f"   ✅ 模型加载成功")
        
        # 2. 检查输入输出
        print(f"\n   📋 模型信息:")
        print(f"      输入:")
        for input_tensor in session.get_inputs():
            print(f"         - {input_tensor.name}: {input_tensor.shape} ({input_tensor.type})")
        
        print(f"      输出:")
        for output_tensor in session.get_outputs():
            print(f"         - {output_tensor.name}: {output_tensor.shape} ({output_tensor.type})")
        
        # 3. 测试推理
        print(f"\n   🧪 测试推理...")
        dummy_input = np.random.randn(1, 3, 224, 224).astype(np.float32)
        outputs = session.run(None, {'input': dummy_input})
        
        print(f"   ✅ 推理测试成功")
        print(f"      - 种族ID: {outputs[0][0]}")
        print(f"      - 性别ID: {outputs[1][0]}")
        print(f"      - 年龄ID: {outputs[2][0]}")
        
        # 4. 显示文件大小
        size_mb = ONNX_MODEL_PATH.stat().st_size / (1024 * 1024)
        print(f"\n   📊 ONNX 模型大小: {size_mb:.1f} MB")
        
        return True
        
    except Exception as e:
        print(f"\n   ❌ 验证失败: {e}")
        import traceback
        traceback.print_exc()
        return False


def cleanup():
    """清理临时文件"""
    if PYTORCH_MODEL_PATH.exists():
        print(f"\n🗑️  清理临时文件...")
        PYTORCH_MODEL_PATH.unlink()
        print(f"   ✅ 已删除 PyTorch 模型")


def main():
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║      🔄 FairFace PyTorch → ONNX 转换脚本                     ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print()
    print("📝 功能:")
    print("   1. 下载 FairFace 官方 PyTorch 模型（最新最准确版本）")
    print("   2. 转换为 ONNX 格式（适用于本项目）")
    print("   3. 验证模型可用性")
    print()
    print("🎯 模型信息:")
    print("   - 架构: ResNet-34")
    print("   - 种族: 7 类（White, Black, Indian, East Asian, etc.）")
    print("   - 年龄: 9 段（0-2, 3-9, ..., 70+）")
    print("   - 性别: 2 类（Male, Female）")
    print("   - 大小: ~100MB")
    print()
    
    # 创建 models 目录
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    
    # 检查是否已存在 ONNX 模型
    if ONNX_MODEL_PATH.exists():
        size_mb = ONNX_MODEL_PATH.stat().st_size / (1024 * 1024)
        print(f"⚠️  ONNX 模型已存在: {ONNX_MODEL_PATH}")
        print(f"   大小: {size_mb:.1f} MB")
        
        response = input("\n是否要重新转换？(y/N): ").strip().lower()
        if response != 'y':
            print("✅ 取消转换，使用现有模型")
            return
        
        ONNX_MODEL_PATH.unlink()
    
    # 执行转换流程
    try:
        # 步骤 1: 下载 PyTorch 模型
        if not download_pytorch_model():
            print("\n❌ 下载失败，转换终止")
            return
        
        # 步骤 2: 转换为 ONNX
        if not convert_to_onnx():
            print("\n❌ 转换失败")
            return
        
        # 步骤 3: 验证 ONNX 模型
        if not verify_onnx_model():
            print("\n❌ 验证失败")
            return
        
        # 步骤 4: 清理临时文件
        cleanup()
        
        # 完成
        print("\n╔═══════════════════════════════════════════════════════════════╗")
        print("║      ✅ 转换成功！                                            ║")
        print("╚═══════════════════════════════════════════════════════════════╝")
        print()
        print(f"📦 ONNX 模型已保存: {ONNX_MODEL_PATH}")
        print()
        print("💡 后续步骤:")
        print("   1. 重启 Python AI 服务")
        print("      命令: pkill -f 'python.*start.py' && python3 start.py &")
        print()
        print("   2. 检查服务日志")
        print("      应该看到: ✅ FairFace ONNX 已加载")
        print()
        
    except KeyboardInterrupt:
        print("\n\n⚠️  用户中断")
    except Exception as e:
        print(f"\n\n❌ 发生错误: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()

