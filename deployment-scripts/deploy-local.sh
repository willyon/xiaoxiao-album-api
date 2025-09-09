#!/bin/bash

# ========================== 本地打包上传脚本 ==========================
# 职责：只负责本地打包和文件上传
#
# 使用方法：
#   ./deploy-local.sh

set -e  # 遇到错误立即退出

# 配置变量
SSH_KEY="/Volumes/Personal-Files/projects/aliCloud/remote-connecting/bingbingcloud-key.pem"
SERVER_USER="xiaoxiao"
SERVER_HOST="8.134.118.242"
SERVER_PATH="/var/www/xiaoxiao-album/backend"

echo "🚀 开始本地打包和上传..."

# ========================== 第一步：本地打包 ==========================
echo "📦 第一步：本地打包代码..."

# 检查必要文件是否存在
if [ ! -f "../package.json" ]; then
    echo "❌ 错误：package.json 不存在"
    exit 1
fi

if [ ! -f "fix-sharp-complete.sh" ]; then
    echo "❌ 错误：fix-sharp-complete.sh 不存在"
    exit 1
fi

if [ ! -f "init-database.js" ]; then
    echo "❌ 错误：init-database.js 不存在"
    exit 1
fi

# 执行打包
echo "🔨 执行 npm run build..."
cd .. && npm run build

if [ $? -ne 0 ]; then
    echo "❌ 打包失败，退出部署"
    exit 1
fi

echo "✅ 本地打包完成"

# ========================== 第二步：上传文件 ==========================
echo "📤 第二步：上传文件到服务器..."

# 上传打包后的代码（包含deploy-server.sh）
echo "📦 上传代码文件..."
rsync -avz --progress --delete --no-times --exclude ".DS_Store" --exclude "database.db" --exclude "localStorage/" --exclude "logs/" --exclude "node_modules/" -e "ssh -i $SSH_KEY" backend-dist/ "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

# 给脚本执行权限
echo "🔑 设置脚本执行权限..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x deployment-scripts/fix-sharp-complete.sh"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x deployment-scripts/deploy-server.sh"

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
echo "✅ 服务器部署脚本上传"
echo "✅ 脚本权限设置"
echo ""
echo "🖥️ 下一步：请SSH到服务器执行部署脚本"
echo ""
echo "📝 服务器部署命令："
echo "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST"
echo "   cd $SERVER_PATH"
echo "   ./deployment-scripts/deploy-server.sh"
echo ""
echo "📝 服务器部署参数（可选）："
echo "   ./deployment-scripts/deploy-server.sh --force-npm     # 强制重新安装npm依赖"
echo "   ./deployment-scripts/deploy-server.sh --skip-npm      # 跳过npm依赖安装"
echo "   ./deployment-scripts/deploy-server.sh --clear-data    # 清理所有数据"
