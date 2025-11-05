#!/bin/bash
# FairFace 和其他 AI 模型下载脚本

set -e

MODELS_DIR="./models"
mkdir -p "$MODELS_DIR"

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║         📦 AI 模型下载脚本                                    ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# FairFace 模型备选下载源
FAIRFACE_URLS=(
    "https://github.com/dchen236/FairFace/releases/download/v1.0/res34_fair_align_multi_7_20190809.pt"
    "https://raw.githubusercontent.com/dchen236/FairFace/master/fair_face_models/res34_fair_align_multi_7_20190809.pt"
    "https://huggingface.co/nateraw/fairface/resolve/main/res34_fair_align_multi_7_20190809.pt"
)

# 尝试下载 FairFace PyTorch 模型
echo "📥 下载 FairFace 模型..."
FAIRFACE_DOWNLOADED=false

for url in "${FAIRFACE_URLS[@]}"; do
    echo "   尝试: $url"
    if wget -q --show-progress -O "$MODELS_DIR/fairface_pytorch.pt" "$url" 2>/dev/null || \
       curl -L -o "$MODELS_DIR/fairface_pytorch.pt" "$url" 2>/dev/null; then
        echo "   ✅ 下载成功"
        FAIRFACE_DOWNLOADED=true
        break
    else
        echo "   ❌ 下载失败，尝试下一个源..."
    fi
done

if [ "$FAIRFACE_DOWNLOADED" = false ]; then
    echo ""
    echo "❌ 所有下载源都失败了"
    echo ""
    echo "💡 手动下载方法："
    echo "   1. 访问: https://github.com/dchen236/FairFace"
    echo "   2. 下载模型文件"
    echo "   3. 放置到: $MODELS_DIR/"
    echo ""
    exit 1
fi

echo ""
echo "✅ FairFace 模型下载完成"
echo "💡 后续步骤："
echo "   1. 运行转换脚本: python3 convert_fairface_to_onnx.py"
echo "   2. 重启 Python AI 服务"
echo ""

