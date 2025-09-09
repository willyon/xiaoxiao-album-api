#!/bin/bash

# ========================== 一键部署脚本 ==========================
# 结合本地打包上传和服务器部署的完整流程
#
# 功能说明：
#   1. 本地打包：执行 npm run build 打包源代码
#   2. 上传文件：使用 rsync 上传到服务器
#   3. 服务器部署：在服务器上执行环境准备、依赖安装、数据清理、数据库操作、服务管理
#   4. 验证部署：检查服务状态和API接口
#
# 使用方法：
#   ./deploy-one-click.sh                    # 默认部署（不安装依赖，不清理数据，不操作数据库）
#   ./deploy-one-click.sh --npm              # 安装npm依赖后部署
#   ./deploy-one-click.sh --clear-data       # 清理所有数据后部署
#   ./deploy-one-click.sh --init-db          # 初始化数据库后部署
#   ./deploy-one-click.sh --rebuild-db       # 重建数据库后部署
#   ./deploy-one-click.sh --npm --clear-data # 安装依赖并清理数据后部署
#   ./deploy-one-click.sh --npm --init-db    # 安装依赖并初始化数据库后部署
#   ./deploy-one-click.sh --npm --rebuild-db # 安装依赖并重建数据库后部署
#   ./deploy-one-click.sh --clear-data --rebuild-db # 清理数据并重建数据库后部署
#   ./deploy-one-click.sh --npm --clear-data --rebuild-db # 完整重置部署
#   ./deploy-one-click.sh --sudo-password PASSWORD  # 提供sudo密码（用于安装Redis和PM2）
#   ./deploy-one-click.sh --npm --sudo-password PASSWORD # 安装依赖并提供sudo密码
#   ./deploy-one-click.sh --rebuild-db --sudo-password PASSWORD # 重建数据库并提供sudo密码
#
# 参数说明：
#   --npm        安装npm依赖并修复Sharp模块（默认跳过）
#   --clear-data 清理所有数据（数据库表、存储文件、队列、Redis键）
#   --init-db    初始化数据库（创建表结构，如果表已存在则跳过）
#   --rebuild-db 重建数据库（删除所有表和数据，重新创建）
#   --sudo-password PASSWORD  提供sudo密码（用于安装Redis和PM2）
#   -h, --help   显示帮助信息
#
# 部署流程：
#   第一步：本地打包代码
#   第二步：上传文件到服务器
#   第三步：服务器部署（环境准备 → 依赖管理 → 数据清理 → 数据库操作 → 服务管理）
#   第四步：验证部署

set -e  # 遇到错误立即退出

# 配置变量
SSH_KEY="/Volumes/Personal-Files/projects/aliCloud/remote-connecting/bingbingcloud-key.pem"
SERVER_USER="xiaoxiao"
SERVER_HOST="8.134.118.242"
SERVER_PATH="/var/www/xiaoxiao-album/backend"

# 创建日志文件（每天一个文件）
LOG_FILE="./one-click-deployment-$(date +%Y%m%d).log"
echo "📝 一键部署日志将保存到: $LOG_FILE"
echo "📝 一键部署日志将保存到: $LOG_FILE" | tee -a "$LOG_FILE"

# 函数：同时输出到终端和日志文件
log() {
    echo "$1" | tee -a "$LOG_FILE"
}

# 函数：记录带时间戳的日志
log_with_time() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# 解析命令行参数
INSTALL_NPM=false
CLEAR_DATA=false
INIT_DB=false
REBUILD_DB=false
SUDO_PASSWORD=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --npm)
            INSTALL_NPM=true
            shift
            ;;
        --clear-data)
            CLEAR_DATA=true
            shift
            ;;
        --init-db)
            INIT_DB=true
            shift
            ;;
        --rebuild-db)
            REBUILD_DB=true
            shift
            ;;
        --sudo-password)
            SUDO_PASSWORD="$2"
            shift 2
            ;;
        -h|--help)
            echo "使用方法："
            echo "  $0                    # 默认部署（不安装依赖）"
            echo "  $0 --npm              # 安装npm依赖后部署"
            echo "  $0 --clear-data        # 清理所有数据后部署"
            echo "  $0 --init-db           # 初始化数据库后部署"
            echo "  $0 --rebuild-db        # 重建数据库后部署"
            echo "  $0 --npm --clear-data  # 安装依赖并清理数据后部署"
            echo "  $0 --npm --init-db     # 安装依赖并初始化数据库后部署"
            echo "  $0 --npm --rebuild-db  # 安装依赖并重建数据库后部署"
            echo "  $0 --clear-data --rebuild-db # 清理数据并重建数据库后部署"
            echo "  $0 --npm --clear-data --rebuild-db  # 完整重置部署"
            echo "  $0 --sudo-password PASSWORD  # 提供sudo密码（用于安装Redis和PM2）"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            echo "使用 -h 或 --help 查看帮助"
            exit 1
            ;;
    esac
done

# 添加部署分隔符
echo "================================================" >> "$LOG_FILE"
log_with_time "🚀 开始一键部署流程..."
log_with_time "📋 部署参数："
log_with_time "   - 安装依赖: $INSTALL_NPM"
log_with_time "   - 清理数据: $CLEAR_DATA"
log_with_time "   - 初始化数据库: $INIT_DB"
log_with_time "   - 重建数据库: $REBUILD_DB"
if [ -n "$SUDO_PASSWORD" ]; then
    log_with_time "   - sudo密码: 已提供"
else
    log_with_time "   - sudo密码: 未提供（如需要会提示输入）"
fi
log_with_time ""

# 检查SSH密钥权限
log "🔐 检查SSH密钥权限..."
if [ ! -f "$SSH_KEY" ]; then
    log "❌ SSH密钥文件不存在: $SSH_KEY"
    exit 1
fi

KEY_PERM=$(stat -f %A "$SSH_KEY" 2>/dev/null || stat -c %a "$SSH_KEY" 2>/dev/null)
if [ "$KEY_PERM" != "600" ]; then
    log "⚠️  SSH密钥权限不正确 ($KEY_PERM)，正在修复..."
    chmod 600 "$SSH_KEY"
    if [ $? -eq 0 ]; then
        log "✅ SSH密钥权限已修复为 600"
    else
        log "❌ 无法修复SSH密钥权限，请手动执行: chmod 600 $SSH_KEY"
        exit 1
    fi
else
    log "✅ SSH密钥权限正确 (600)"
fi

# ========================== 第一步：本地打包 ==========================
log "📦 第一步：本地打包代码..."

# 执行打包
log "🔨 执行 npm run build..."
npm run build

if [ $? -ne 0 ]; then
    log "❌ 打包失败，退出部署"
    exit 1
fi

log "✅ 本地打包完成"

# ========================== 第二步：上传文件 ==========================
log "📤 第二步：上传文件到服务器..."

# 测试SSH连接
log "🔐 测试SSH连接..."
ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$SERVER_USER@$SERVER_HOST" "echo 'SSH连接成功'" 2>/dev/null
if [ $? -ne 0 ]; then
    log "❌ SSH连接失败，请检查："
    log "   1. SSH密钥文件是否存在: $SSH_KEY"
    log "   2. SSH密钥权限是否正确: chmod 600 $SSH_KEY"
    log "   3. 服务器地址和用户名是否正确"
    log "   4. 服务器是否允许密钥认证"
    exit 1
fi
log "✅ SSH连接测试成功"

# 上传打包后的代码
log "📦 上传代码文件..."
rsync -avz --progress --delete --no-times --exclude ".DS_Store" --exclude "database.db" --exclude "localStorage/" --exclude "logs/" --exclude "node_modules/" -e "ssh -i $SSH_KEY -o BatchMode=yes" backend-dist/ "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

# 给脚本执行权限
log "🔑 设置脚本执行权限..."
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x deployment-scripts/fix-sharp-complete.sh"
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && chmod +x deployment-scripts/deploy-server.sh"

if [ $? -ne 0 ]; then
    log "❌ 文件上传失败，退出部署"
    exit 1
fi

log "✅ 文件上传完成"

# ========================== 第三步：服务器部署 ==========================
log "🖥️ 第三步：在服务器上执行部署..."

# 构建服务器部署命令
SERVER_CMD="./deployment-scripts/deploy-server.sh"

if [ "$INSTALL_NPM" = true ]; then
    SERVER_CMD="$SERVER_CMD --npm"
fi

if [ "$CLEAR_DATA" = true ]; then
    SERVER_CMD="$SERVER_CMD --clear-data"
fi

if [ "$INIT_DB" = true ]; then
    SERVER_CMD="$SERVER_CMD --init-db"
fi

if [ "$REBUILD_DB" = true ]; then
    SERVER_CMD="$SERVER_CMD --rebuild-db"
fi

if [ -n "$SUDO_PASSWORD" ]; then
    SERVER_CMD="$SERVER_CMD --sudo-password '$SUDO_PASSWORD'"
fi

# 在服务器上执行部署
log "🚀 执行服务器部署命令: $SERVER_CMD"
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && $SERVER_CMD"

if [ $? -ne 0 ]; then
    log "❌ 服务器部署失败"
    exit 1
fi

log "✅ 服务器部署完成"

# ========================== 第四步：验证部署 ==========================
log "🧪 第四步：验证部署..."

# 等待服务启动
log "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
log "📊 检查服务状态..."
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && pm2 status"

# 测试API接口
log "🌐 测试API接口..."
curl -s -X POST -H 'Content-Type: application/json' -d '{"email":"test@example.com","password":"test123"}' http://localhost:3000/auth/loginOrRegister | head -c 200

log_with_time ""
log_with_time "🎉 一键部署完成！"
log_with_time ""
log_with_time "📋 部署总结："
log_with_time "✅ 本地代码打包"
log_with_time "✅ 文件上传到服务器"
log_with_time "✅ 服务器环境准备"
if [ "$INSTALL_NPM" = true ]; then
    log_with_time "✅ npm依赖安装"
fi
if [ "$CLEAR_DATA" = true ]; then
    log_with_time "✅ 数据清理（数据库、文件、队列）"
fi
if [ "$INIT_DB" = true ]; then
    log_with_time "✅ 数据库初始化"
fi
if [ "$REBUILD_DB" = true ]; then
    log_with_time "✅ 数据库重建"
fi
log_with_time "✅ 数据库表创建"
log_with_time "✅ 目录结构创建"
log_with_time "✅ 服务启动和配置"
log_with_time ""
log_with_time "🌐 你的API现在可以通过以下地址访问："
log_with_time "   https://photos.bingbingcloud.com/auth/loginOrRegister"
log_with_time "   https://photos.bingbingcloud.com/images/queryAllByPage"
log_with_time ""
log_with_time "📝 常用PM2命令："
log_with_time "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST 'pm2 status'"
log_with_time "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST 'pm2 logs'"
log_with_time "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST 'pm2 restart all'"
log_with_time "   ssh -i $SSH_KEY $SERVER_USER@$SERVER_HOST 'pm2 stop all'"
log_with_time ""
log_with_time "📄 一键部署日志已保存到: $LOG_FILE"
