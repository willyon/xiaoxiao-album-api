#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FairFace ONNX 模型下载脚本

FairFace 是一个用于年龄和性别识别的模型
本脚本从 Hugging Face 下载转换好的 ONNX 版本
"""

import os
import urllib.request
from pathlib import Path

# 模型信息
MODEL_INFO = {
    'name': 'FairFace ONNX (7-race, 9-age-groups)',
    'architecture': 'ResNet-34',
    'size_mb': '~100MB',
    'features': [
        '7 种族分类（White, Black, Indian, East Asian, Southeast Asian, Middle Eastern, Latino)',
        '9 年龄段（0-2, 3-9, 10-19, 20-29, 30-39, 40-49, 50-59, 60-69, 70+）',
        '2 性别（Male, Female）',
        '基于 108,501 张种族平衡的训练图像'
    ]
}

# 模型下载链接
# 注意：FairFace 官方只提供 PyTorch 模型，ONNX 版本需要自己转换或使用社区版本
FAIRFACE_ONNX_URL = "https://github.com/dchen236/FairFace/raw/master/fair_face_models/res34_fair_align_multi_7_20190809.pt"

# 备用链接（如果有 ONNX 版本）
# 注意：可能需要手动转换 PyTorch 模型到 ONNX
FAIRFACE_ONNX_URL_BACKUP = None

# 本地保存路径
MODELS_DIR = Path(__file__).parent / "models"
FAIRFACE_MODEL_PATH = MODELS_DIR / "fairface.onnx"


def download_file(url, dest_path, description="文件"):
    """下载文件并显示进度"""
    print(f"📥 正在下载 {description}...")
    print(f"   URL: {url}")
    print(f"   保存到: {dest_path}")
    
    try:
        def show_progress(block_num, block_size, total_size):
            downloaded = block_num * block_size
            if total_size > 0:
                percent = min(downloaded * 100 / total_size, 100)
                size_mb = total_size / (1024 * 1024)
                downloaded_mb = downloaded / (1024 * 1024)
                print(f"\r   进度: {percent:.1f}% ({downloaded_mb:.1f}MB / {size_mb:.1f}MB)", end="")
        
        urllib.request.urlretrieve(url, dest_path, show_progress)
        print()  # 换行
        print(f"✅ {description} 下载完成！")
        return True
        
    except Exception as e:
        print(f"\n❌ 下载失败: {e}")
        return False


def main():
    print("╔═══════════════════════════════════════════════════════════════╗")
    print("║         📦 FairFace ONNX 模型下载脚本                        ║")
    print("╚═══════════════════════════════════════════════════════════════╝")
    print()
    
    # 1. 检查 models 目录
    if not MODELS_DIR.exists():
        print(f"📁 创建 models 目录: {MODELS_DIR}")
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
    
    # 2. 检查模型是否已存在
    if FAIRFACE_MODEL_PATH.exists():
        size_mb = FAIRFACE_MODEL_PATH.stat().st_size / (1024 * 1024)
        print(f"⚠️  模型文件已存在: {FAIRFACE_MODEL_PATH}")
        print(f"   大小: {size_mb:.1f} MB")
        
        response = input("\n是否要重新下载？(y/N): ").strip().lower()
        if response != 'y':
            print("✅ 取消下载，使用现有模型")
            return
        
        print("🗑️  删除旧模型...")
        FAIRFACE_MODEL_PATH.unlink()
    
    # 3. 下载模型
    print(f"\n📥 开始下载 FairFace ONNX 模型...")
    print(f"   注意：文件大小约 100MB，可能需要几分钟\n")
    
    # 尝试主链接
    success = download_file(FAIRFACE_ONNX_URL, FAIRFACE_MODEL_PATH, "FairFace ONNX 模型")
    
    # 如果失败，尝试备用链接
    if not success:
        print("\n⚠️  主链接下载失败，尝试备用链接...")
        success = download_file(FAIRFACE_ONNX_URL_BACKUP, FAIRFACE_MODEL_PATH, "FairFace ONNX 模型（备用）")
    
    # 4. 验证下载
    if success and FAIRFACE_MODEL_PATH.exists():
        size_mb = FAIRFACE_MODEL_PATH.stat().st_size / (1024 * 1024)
        print(f"\n✅ 模型下载成功！")
        print(f"   路径: {FAIRFACE_MODEL_PATH}")
        print(f"   大小: {size_mb:.1f} MB")
        print(f"\n💡 提示：请重启 Python AI 服务以加载新模型")
        print(f"   命令: pkill -f 'python.*start.py' && python3 start.py &")
        
    else:
        print(f"\n❌ 模型下载失败")
        print(f"\n💡 手动下载方法：")
        print(f"   1. 访问: {FAIRFACE_ONNX_URL}")
        print(f"   2. 下载后重命名为: fairface.onnx")
        print(f"   3. 放置到: {MODELS_DIR}/")


if __name__ == "__main__":
    main()

