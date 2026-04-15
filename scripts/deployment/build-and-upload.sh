#!/bin/bash

# ========================== 本地打包并上传 ==========================
# 职责：在本地打包代码，并 rsync 上传到服务器（不执行服务器端部署）
#
# 使用方法（在项目根目录下）：
#   ./scripts/deployment/build-and-upload.sh

set -e  # 遇到错误立即退出

# 配置变量
SSH_KEY="/Volumes/Personal-Files/projects/aliCloud/remote-connecting/bingbingcloud-key.pem"
SERVER_USER="xiaoxiao"
SERVER_HOST="8.134.118.242"
SERVER_PATH="/var/www/photos.bingbingcloud.com/backend"

# 若在 scripts/deployment 下执行，则上两级是项目根
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../../package.json" ]; then
  PROJECT_ROOT="$SCRIPT_DIR/../.."
else
  PROJECT_ROOT="$(pwd)"
fi

echo "🚀 开始本地打包和上传..."

# ========================== 第一步：本地打包 ==========================
echo "📦 第一步：本地打包代码..."

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
    echo "❌ 错误：package.json 不存在"
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/fix-sharp-complete.sh" ]; then
    echo "❌ 错误：fix-sharp-complete.sh 不存在"
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/rebuild-database.js" ]; then
    echo "❌ 错误：rebuild-database.js 不存在"
    exit 1
fi

echo "🔨 执行 npm run build..."
cd "$PROJECT_ROOT" && npm run build

if [ $? -ne 0 ]; then
    echo "❌ 打包失败，退出部署"
    exit 1
fi

echo "✅ 本地打包完成"

# ========================== 第二步：上传文件 ==========================
echo "📤 第二步：上传文件到服务器..."

echo "📦 上传代码文件..."
rsync -avz --progress --delete --no-times --exclude ".DS_Store" --exclude "database.db" --exclude "storage-local/" --exclude "logs/" --exclude "node_modules/" -e "ssh -i $SSH_KEY" "$PROJECT_ROOT/backend-dist/" "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

echo "🔑 设置脚本执行权限..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x scripts/deployment/fix-sharp-complete.sh"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x scripts/deployment/server-deploy.sh"

if [ $? -ne 0 ]; then
    echo "❌ 设置脚本执行权限失败，退出部署"
    exit 1
fi

echo "✅ 文件上传完成"

echo ""
echo "🎉 本地打包和上传完成！"
echo ""
echo "📋 完成的工作："
echo "✅ 代码打包"
echo "✅ 文件上传到服务器"
echo "✅ 服务器部署脚本已上传"
echo "✅ 脚本权限已设置"
echo ""
echo "🖥️ 下一步：SSH 到服务器执行部署脚本"
echo ""
echo "📝 服务器部署命令："
echo "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST"
echo "   cd $SERVER_PATH"
echo "   ./scripts/deployment/server-deploy.sh"
echo ""
echo "📝 可选参数："
echo "   ./scripts/deployment/server-deploy.sh --npm          # 安装 npm 依赖并修复 Sharp"
echo "   ./scripts/deployment/server-deploy.sh --clear-data   # 清理所有数据"
echo "   ./scripts/deployment/server-deploy.sh --init-db      # 初始化数据库"
echo "   ./scripts/deployment/server-deploy.sh --rebuild-db   # 重建数据库"
