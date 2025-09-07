#!/bin/bash

# ========================== 完整后端部署脚本 ==========================
# 包含：Redis安装、Sharp修复、数据库初始化、目录创建、服务启动等所有步骤
#
# 使用方法：
#   ./deploy-complete.sh                    # 智能安装npm依赖（默认）
#   ./deploy-complete.sh --force-npm        # 强制重新安装npm依赖
#   ./deploy-complete.sh --skip-npm         # 跳过npm依赖安装

set -e  # 遇到错误立即退出

# 创建日志文件
LOG_FILE="deployment-$(date +%Y%m%d-%H%M%S).log"
echo "📝 部署日志将保存到: $LOG_FILE"
echo "📝 部署日志将保存到: $LOG_FILE" | tee -a "$LOG_FILE"

# 函数：同时输出到终端和日志文件
log() {
    echo "$1" | tee -a "$LOG_FILE"
}

# 解析命令行参数
FORCE_NPM=false
SKIP_NPM=false
CLEAR_DATA=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --force-npm)
            FORCE_NPM=true
            shift
            ;;
        --skip-npm)
            SKIP_NPM=true
            shift
            ;;
        --clear-data)
            CLEAR_DATA=true
            shift
            ;;
        -h|--help)
            echo "使用方法："
            echo "  $0                    # 智能安装npm依赖（默认）"
            echo "  $0 --force-npm         # 强制重新安装npm依赖"
            echo "  $0 --skip-npm          # 跳过npm依赖安装"
            echo "  $0 --clear-data        # 清理所有数据（数据库、文件、队列）"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            echo "使用 -h 或 --help 查看帮助"
            exit 1
            ;;
    esac
done

# 配置变量
SSH_KEY="/Volumes/Personal-Files/projects/aliCloud/remote-connecting/bingbingcloud-key.pem"
SERVER_USER="xiaoxiao"
SERVER_HOST="8.134.118.242"
SERVER_PATH="/var/www/xiaoxiao-album/backend"

log "🚀 开始完整后端部署..."
log "📋 npm依赖安装模式："
if [ "$FORCE_NPM" = true ]; then
    log "   🔄 强制重新安装npm依赖"
elif [ "$SKIP_NPM" = true ]; then
    log "   ⏭️  跳过npm依赖安装"
else
    log "   🧠 智能安装npm依赖（检查后安装）"
fi

log "📋 数据清理模式："
if [ "$CLEAR_DATA" = true ]; then
    log "   🗑️  清理所有数据（数据库、文件、队列）"
else
    log "   💾 保留现有数据"
fi
log ""

# ========================== 第一步：本地打包 ==========================
log "📦 第一步：本地打包代码..."

# 检查必要文件是否存在
if [ ! -f "../package.json" ]; then
    echo "❌ 错误：package.json 不存在"
    exit 1
fi

if [ ! -f "init-database.js" ]; then
    echo "❌ 错误：init-database.js 不存在"
    exit 1
fi

if [ ! -f "fix-sharp-complete.sh" ]; then
    echo "❌ 错误：fix-sharp-complete.sh 不存在"
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

# 上传打包后的代码
echo "📦 上传代码文件..."
      rsync -avz --progress --delete --no-times --exclude ".DS_Store" --exclude "database.db" --exclude "localStorage/" --exclude "logs/" -e "ssh -i $SSH_KEY" backend-dist/ "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

# 环境变量文件已包含在打包中

# 给脚本执行权限
echo "🔑 设置脚本执行权限..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x deployment-scripts/fix-sharp-complete.sh"

if [ $? -ne 0 ]; then
    echo "❌ 文件上传失败，退出部署"
    exit 1
fi

echo "✅ 文件上传完成"

# ========================== 第三步：服务器环境准备 ==========================
echo "🛠️ 第三步：服务器环境准备..."

# 创建必要的目录结构
echo "📁 创建目录结构..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && mkdir -p localStorage/processed/original localStorage/processed/highres localStorage/processed/thumbnail localStorage/processing/failed localStorage/upload logs"

# 检查并安装Redis
echo "🔍 检查Redis服务..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "
if ! command -v redis-cli &> /dev/null; then
    echo '📦 Redis未安装，开始安装...'
    echo ''
    sudo apt update
    sudo apt install -y redis-server
    sudo systemctl start redis-server
    sudo systemctl enable redis-server
    echo '✅ Redis安装完成'
else
    echo '✅ Redis已安装'
fi
"

# 检查Redis服务状态
echo "🔍 检查Redis服务状态..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "
if systemctl is-active --quiet redis-server; then
    echo '✅ Redis服务正在运行'
else
    echo '⚠️  Redis服务未运行，尝试启动...'
    sudo systemctl start redis-server
fi
"

# ========================== 第四步：安装依赖和修复Sharp ==========================
echo "📦 第四步：安装依赖和修复Sharp..."

# 检查并安装npm依赖
if [ "$SKIP_NPM" = true ]; then
    echo "⏭️ 跳过npm依赖安装"
else
    echo "📦 检查npm依赖..."
    ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && 
    echo '🔍 检查条件：'
    echo '  - 强制安装: '$FORCE_NPM''
    echo '  - node_modules存在: '$(test -d node_modules && echo true || echo false)''
    echo '  - package-lock.json存在: '$(test -f package-lock.json && echo true || echo false)''
    echo '  - package.json时间戳: '$(stat -c %Y package.json 2>/dev/null || echo 'N/A')''
    echo '  - package-lock.json时间戳: '$(stat -c %Y package-lock.json 2>/dev/null || echo 'N/A')''
    echo '  - package.json比package-lock.json新: '$(test package.json -nt package-lock.json 2>/dev/null && echo true || echo false)''
    # 检查是否需要重新安装依赖
    NEED_INSTALL=false
    
    if [ '$FORCE_NPM' = true ]; then
        NEED_INSTALL=true
        echo '🔄 强制重新安装npm依赖...'
    elif [ ! -d 'node_modules' ]; then
        NEED_INSTALL=true
        echo '📦 node_modules不存在，需要安装...'
    elif [ ! -f 'package-lock.json' ]; then
        NEED_INSTALL=true
        echo '📦 package-lock.json不存在，需要安装...'
    elif [ 'package.json' -nt 'package-lock.json' ]; then
        NEED_INSTALL=true
        echo '📦 package.json比package-lock.json新，需要安装...'
    else
        echo '✅ npm依赖已是最新，跳过安装'
    fi
    
    if [ '$NEED_INSTALL' = true ]; then
        echo '🧹 清理npm缓存...'
        npm cache clean --force
        echo '📦 安装npm依赖...'
        npm install --production
        echo '✅ npm依赖安装完成'
    else
        echo '✅ npm依赖已是最新，跳过安装'
    fi
    "
fi

# 安装PM2（如果未安装）
echo "📦 检查并安装PM2..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "
if ! command -v pm2 &> /dev/null; then
    echo '📦 PM2未安装，开始全局安装...'
    echo ''
    echo '🔐 ==============================================='
    echo '⚠️  需要输入sudo密码来安装PM2'
    echo '🔐 请在下面输入你的sudo密码：'
    echo '🔐 ==============================================='
    echo ''
    sudo npm install -g pm2
    echo '✅ PM2安装完成'
else
    echo '✅ PM2已安装'
fi
"

# 修复Sharp模块
echo "🔧 修复Sharp模块（包含系统库安装）..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && ./deployment-scripts/fix-sharp-complete.sh"

# ========================== 第五步：数据清理（可选） ==========================
if [ "$CLEAR_DATA" = true ]; then
    log "🗑️ 第五步：清理所有数据..."
    
    # 清理数据库和文件
    log "📊 清理数据库和文件..."
    ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && node scripts/clearAllAboutImageData.js"
    
    # 清理队列
    log "📋 清理队列..."
    ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && node scripts/clearQueues.js"
    
    log "✅ 数据清理完成"
else
    log "⏭️ 跳过数据清理，保留现有数据"
fi

# ========================== 第六步：数据库初始化 ==========================
log "🗄️ 第六步：数据库初始化..."

# 初始化数据库表
log "📊 创建数据库表..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && node deployment-scripts/init-database.js"

# ========================== 第七步：服务管理 ==========================
log "🚀 第七步：启动服务..."

# 停止现有服务
log "⏹️ 停止现有服务..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 stop all || true"

# 删除现有服务
log "🗑️ 删除现有服务..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 delete all || true"

# 启动新服务
log "🚀 启动新服务..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 start ecosystem.config.js"

# 保存PM2配置
log "💾 保存PM2配置..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 save"

# ========================== 第八步：验证部署 ==========================
log "🧪 第八步：验证部署..."

# 等待服务启动
log "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
log "📊 检查服务状态..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 status"

# 测试API接口
log "🌐 测试API接口..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "curl -s -X POST -H 'Content-Type: application/json' -d '{\"email\":\"test@example.com\",\"password\":\"test123\"}' http://localhost:3000/auth/loginOrRegister | head -c 200"

echo ""
log "🎉 完整后端部署完成！"
log ""
log "📋 部署总结："
log "✅ 代码打包和上传"
log "✅ Redis服务安装和启动"
log "✅ PM2进程管理器安装"
log "✅ Sharp模块修复"
if [ "$CLEAR_DATA" = true ]; then
    log "✅ 数据清理（数据库、文件、队列）"
fi
log "✅ 数据库表创建"
log "✅ 目录结构创建"
log "✅ 服务启动和配置"
log ""
log "🌐 你的API现在可以通过以下地址访问："
log "   https://photos.bingbingcloud.com/auth/loginOrRegister"
log "   https://photos.bingbingcloud.com/images/queryAllByPage"
log ""
log "📝 如需查看服务状态，请运行："
log "   ssh -i \$SSH_KEY \$SERVER_USER@\$SERVER_HOST 'pm2 status'"
log ""
log "📝 如需查看服务日志，请运行："
log "   ssh -i \$SSH_KEY \$SERVER_USER@\$SERVER_HOST 'pm2 logs'"
log ""
log "📝 如需清理队列，请运行："
log "   ssh -i \$SSH_KEY \$SERVER_USER@\$SERVER_HOST 'cd \$SERVER_PATH && node scripts/clearQueues.js'"
log ""
log "📄 完整部署日志已保存到: \$LOG_FILE"
