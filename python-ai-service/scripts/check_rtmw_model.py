#!/usr/bin/env python3
"""检查 RTMW-x ONNX 模型的输入输出尺寸"""

import onnxruntime as ort
import json

# 加载模型
model_path = "models/rtmw-x_simcc-cocktail13/end2end.onnx"
session = ort.InferenceSession(model_path)

print("=" * 60)
print("📦 RTMW-x ONNX 模型信息")
print("=" * 60)

# 输入信息
print("\n🔹 输入信息:")
for input_tensor in session.get_inputs():
    print(f"   名称: {input_tensor.name}")
    print(f"   形状: {input_tensor.shape}")
    print(f"   类型: {input_tensor.type}")

# 输出信息
print("\n🔹 输出信息:")
for output_tensor in session.get_outputs():
    print(f"   名称: {output_tensor.name}")
    print(f"   形状: {output_tensor.shape}")
    print(f"   类型: {output_tensor.type}")

# 读取配置文件
print("\n🔹 配置文件信息:")
with open("models/rtmw-x_simcc-cocktail13/detail.json") as f:
    detail = json.load(f)
    print(f"   input_shape: {detail['onnx_config']['input_shape']}")
    
with open("models/rtmw-x_simcc-cocktail13/pipeline.json") as f:
    pipeline = json.load(f)
    preprocess = pipeline['pipeline']['tasks'][0]['transforms']
    for transform in preprocess:
        if 'image_size' in transform:
            print(f"   {transform['type']}: {transform['image_size']}")
        if 'mean' in transform:
            print(f"   归一化均值: {transform['mean']}")
            print(f"   归一化标准差: {transform['std']}")
    
    # 查找 simcc_split_ratio
    postprocess = pipeline['pipeline']['tasks'][2]
    print(f"   simcc_split_ratio: {postprocess['params']['simcc_split_ratio']}")

print("\n" + "=" * 60)

