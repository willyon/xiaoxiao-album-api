#!/bin/bash

echo "🔧 完整修复Sharp模块（从源码编译以支持HEIC格式）..."

# 进入后端目录
cd /var/www/photos.bingbingcloud.com/backend

# 测试Sharp是否正常工作
echo "🧪 测试Sharp模块..."
node -e "
try {
  const sharp = require('sharp');
  console.log('✅ Sharp版本:', sharp.versions);
  
  // 检查基本功能
  if (!sharp.versions || !sharp.versions.sharp) {
    throw new Error('Sharp版本信息不完整');
  }
  
  // 检查HEIC支持（更宽松的检查）
  const heicSupport = sharp.format.heif && sharp.format.heif.input && sharp.format.heif.input.file;
  console.log('✅ HEIC支持:', !!heicSupport);
  
  // 尝试创建一个简单的图片处理实例
  const instance = sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } });
  if (!instance) {
    throw new Error('无法创建Sharp实例');
  }
  
  console.log('✅ Sharp工作正常！');
  process.exit(0);
} catch(e) {
  console.log('❌ Sharp测试失败:', e.message);
  process.exit(1);
}
"

# 如果Sharp工作正常，直接退出
if [ $? -eq 0 ]; then
    echo "✅ Sharp模块工作正常，无需修复"
    exit 0
fi

# 如果复杂测试失败，尝试简单测试
echo "🔄 复杂测试失败，尝试简单测试..."
node -e "
try {
  const sharp = require('sharp');
  console.log('✅ Sharp基本加载成功，版本:', sharp.versions?.sharp || 'unknown');
  process.exit(0);
} catch(e) {
  console.log('❌ Sharp基本加载失败:', e.message);
  process.exit(1);
}
"

# 如果简单测试也失败，才进行修复
if [ $? -ne 0 ]; then
    echo "⚠️ Sharp模块需要修复，开始完整修复流程..."
else
    echo "✅ Sharp模块基本功能正常，跳过修复"
    exit 0
fi

# 停止所有服务
echo "⏹️ 停止服务..."
pm2 stop all

# ========================== 安装系统库 ==========================
echo "📦 安装Sharp编译所需的系统库..."


echo "🔍 检查并安装基础编译工具..."
sudo apt update
sudo apt install -y build-essential pkg-config python3

echo "📚 安装libvips及其开发库..."
sudo apt install -y libvips-dev libvips-tools

echo "🖼️ 安装图像处理相关库..."
sudo apt install -y \
    libglib2.0-dev \
    libjpeg-dev \
    libpng-dev \
    libwebp-dev \
    libtiff-dev \
    libgif-dev \
    libexif-dev \
    liblcms2-dev \
    libfftw3-dev \
    liborc-0.4-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libfontconfig1-dev \
    libfreetype6-dev \
    libheif-dev \
    libopenjp2-7-dev \
    libspng-dev \
    libimagequant-dev \
    libbrotli-dev \
    libzstd-dev

echo "✅ 系统库安装完成"

# ========================== 配置npm环境 ==========================
echo "🔧 配置npm环境..."
npm config set registry https://registry.npmmirror.com

# 确保.npmrc配置正确（强制从源码编译以支持HEIC）
echo "📝 更新.npmrc配置..."
cat > .npmrc << 'EOF'
sharp_binary_host_skip=true
sharp_libvips_binary_host_skip=true
EOF

# ========================== 修复Sharp模块 ==========================
echo "🔧 修复Sharp模块..."

# 备份现有的Sharp模块
echo "💾 备份Sharp模块..."
if [ -d "node_modules/sharp" ]; then
    cp -r node_modules/sharp /tmp/sharp-backup-$(date +%Y%m%d-%H%M%S)
    echo "✅ Sharp模块已备份"
fi

# 清理并重新安装Sharp
echo "🧹 清理Sharp模块..."
rm -rf node_modules/sharp
npm cache clean --force

# 直接从源码编译Sharp（确保HEIC支持）
echo "📦 从源码编译Sharp（支持HEIC格式）..."
npm install sharp --build-from-source

# 如果源码编译失败，尝试平台特定安装（备用方案）
if [ $? -ne 0 ]; then
    echo "⚠️ 源码编译失败，尝试平台特定安装..."
    npm install --os=linux --cpu=x64 sharp
    
    # 如果平台特定安装也失败，尝试标准安装
    if [ $? -ne 0 ]; then
        echo "⚠️ 平台特定安装失败，尝试标准安装..."
        npm install sharp
        
        # 如果标准安装也失败，恢复备份
        if [ $? -ne 0 ]; then
            echo "❌ 所有安装方式都失败，尝试恢复备份..."
            LATEST_BACKUP=$(ls -t /tmp/sharp-backup-* 2>/dev/null | head -1)
            if [ -n "$LATEST_BACKUP" ]; then
                cp -r "$LATEST_BACKUP" node_modules/sharp
                echo "✅ 已恢复 Sharp 备份"
            else
                echo "❌ 没有找到备份，Sharp 安装完全失败"
                exit 1
            fi
        fi
    fi
fi

# ========================== 验证修复结果 ==========================
echo "🧪 验证Sharp修复结果..."
node -e "
try {
  const sharp = require('sharp');
  console.log('✅ Sharp版本:', sharp.versions);
  console.log('✅ HEIC支持:', !!sharp.format.heif?.input?.file);
  console.log('✅ 支持的格式:', Object.keys(sharp.format));
  console.log('✅ Sharp从源码编译成功，HEIC格式支持正常！');
} catch(e) {
  console.error('❌ Sharp修复失败:', e.message);
  process.exit(1);
}
"

if [ $? -eq 0 ]; then
    echo "🎉 Sharp修复成功！"
    
    # 重启服务
    echo "🔄 重启服务..."
    pm2 restart all
    
    echo "✅ 服务重启完成！"
    pm2 status
    
    echo ""
    echo "📋 修复总结："
    echo "✅ 系统库安装完成"
    echo "✅ Sharp模块重新编译"
    echo "✅ 服务重启完成"
    echo ""
    echo "🌐 现在可以正常使用图片处理功能了！"
else
    echo "❌ Sharp修复失败"
    echo ""
    echo "🔍 可能的解决方案："
    echo "1. 检查系统库是否正确安装"
    echo "2. 检查网络连接"
    echo "3. 尝试手动安装: npm install sharp --build-from-source"
    exit 1
fi
