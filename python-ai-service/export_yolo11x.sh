#!/bin/bash
# 导出 YOLOv11x 为 ONNX 格式

cd "$(dirname "$0")/.."

echo "=========================================="
echo "导出 YOLOv11x 为 ONNX 格式"
echo "=========================================="
echo ""

# 方法1: 使用venv（如果venv正常）
if [ -f "venv/bin/python3" ] && [ -x "venv/bin/python3" ]; then
    echo "📦 使用venv中的Python..."
    PYTHON_CMD="venv/bin/python3"
elif [ -f "python-ai-service/venv/bin/python3" ] && [ -x "python-ai-service/venv/bin/python3" ]; then
    echo "📦 使用python-ai-service/venv中的Python..."
    PYTHON_CMD="python-ai-service/venv/bin/python3"
else
    echo "⚠️  未找到venv，使用系统Python3..."
    PYTHON_CMD="python3"
fi

echo ""

# 检查ultralytics是否已安装
echo "🔍 检查ultralytics..."
$PYTHON_CMD -c "import ultralytics; print('✅ ultralytics版本:', ultralytics.__version__)" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "❌ ultralytics未安装，正在安装..."
    $PYTHON_CMD -m pip install -U ultralytics 2>&1 | tail -5
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ 安装失败，请手动安装:"
        echo "   $PYTHON_CMD -m pip install -U ultralytics"
        exit 1
    fi
fi

echo ""
echo "🔄 导出 YOLOv11x 为 ONNX..."
echo "   （首次运行会下载模型，可能需要几分钟）"
echo ""

# 导出模型
$PYTHON_CMD -c "
from ultralytics import YOLO
import os
import shutil

print('📥 下载并加载 yolo11x.pt...')
model = YOLO('yolo11x.pt')
print('✅ 模型已加载\n')

print('🔄 导出为 ONNX 格式...')
success = model.export(
    format='onnx',
    imgsz=640,
    simplify=True,
    opset=12
)

if success:
    onnx_path = 'yolo11x.onnx'
    if os.path.exists(onnx_path):
        file_size = os.path.getsize(onnx_path) / (1024 * 1024)
        print(f'\n✅ 导出成功！')
        print(f'   文件: {onnx_path}')
        print(f'   大小: {file_size:.2f} MB\n')
        
        # 备份旧模型
        target_dir = 'python-ai-service/models'
        old_model = os.path.join(target_dir, 'yolov10s.onnx')
        if os.path.exists(old_model):
            backup_path = old_model + '.backup'
            shutil.move(old_model, backup_path)
            print(f'📦 已备份旧模型: {backup_path}')
        
        # 移动到models目录
        target_path = os.path.join(target_dir, 'yolov10s.onnx')
        os.makedirs(target_dir, exist_ok=True)
        shutil.move(onnx_path, target_path)
        print(f'📁 已移动到: {target_path}')
        print(f'   （保持文件名 yolov10s.onnx 以兼容现有代码）\n')
        print('='*50)
        print('🎉 YOLOv11x 导出完成！')
        print('='*50)
    else:
        print('❌ ONNX文件未找到')
else:
    print('❌ 导出失败')
"

echo ""
echo "📝 下一步:"
echo "   1. 重启 Python AI 服务"
echo "   2. 测试检测效果"
echo ""

