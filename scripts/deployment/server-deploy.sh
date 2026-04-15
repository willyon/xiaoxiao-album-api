#!/bin/bash

# ========================== 服务器端部署 ==========================
# 在服务器上执行：环境准备、依赖安装、数据清理、数据库操作、服务启停
#
# 功能说明：
#   1. 服务器环境准备：创建目录结构、检查Redis服务、安装PM2
#   2. 依赖管理：清理npm缓存、安装依赖、修复Sharp模块（可选）
#   3. 数据清理：清理存储文件、队列、Redis键（可选）
#   4. 数据库操作：初始化或重建数据库（可选）
#   5. 服务管理：停止旧服务、启动新服务、保存PM2配置
#   6. 验证部署：检查服务状态
#
# 使用方法（在服务器项目目录下）：
#   ./deployment-scripts/server-deploy.sh                    # 默认部署（不安装依赖，不清理数据，不操作数据库）
#   ./deployment-scripts/server-deploy.sh --npm              # 安装npm依赖后部署
#   ./deployment-scripts/server-deploy.sh --clear-data        # 清理所有数据后部署
#   ./deployment-scripts/server-deploy.sh --init-db           # 初始化数据库后部署
#   ./deployment-scripts/server-deploy.sh --rebuild-db        # 重建数据库后部署
#   ./deployment-scripts/server-deploy.sh --npm --clear-data  # 安装依赖并清理数据后部署
#   ./deployment-scripts/server-deploy.sh --sudo-password PASSWORD # 提供sudo密码（用于安装Redis和PM2）
#
# 参数说明：
#   --npm        安装npm依赖并修复Sharp模块（默认跳过）
#   --clear-data 清理所有数据（数据库表、存储文件、队列、Redis键）
#   --init-db    初始化数据库（创建表结构，若表已存在则跳过）
#   --rebuild-db 重建数据库（删除所有表和数据，重新创建）
#   --sudo-password PASSWORD  提供sudo密码（用于安装Redis和PM2）
#   -h, --help   显示帮助信息
#
# 执行流程：
#   服务器环境准备 → 依赖管理 → 数据清理 → 数据库操作 → 服务管理 → 验证部署

set -e  # 遇到错误立即退出

# 创建日志文件
LOG_FILE="./server-deployment-$(date +%Y%m%d-%H%M%S).log"
echo "📝 服务器部署日志将保存到: $LOG_FILE"
echo "📝 服务器部署日志将保存到: $LOG_FILE" | tee -a "$LOG_FILE"

# 函数：同时输出到终端和日志文件
log() {
    echo "$1" | tee -a "$LOG_FILE"
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
            echo "  $0 --npm --clear-data --rebuild-db # 完整重置部署"
            echo "  $0 --sudo-password PASSWORD  # 提供sudo密码（用于安装Redis和PM2）"
            echo ""
            echo "参数说明："
            echo "  --npm        安装npm依赖并修复Sharp模块（默认跳过）"
            echo "  --clear-data 清理所有数据（数据库、文件、队列）"
            echo "  --init-db    初始化数据库（创建表结构，如果表已存在则跳过）"
            echo "  --rebuild-db 重建数据库（删除所有表和数据，重新创建）"
            echo "  --sudo-password PASSWORD  提供sudo密码（用于安装Redis和PM2）"
            echo "  -h, --help   显示帮助信息"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            echo "使用 -h 或 --help 查看帮助"
            exit 1
            ;;
    esac
done

log "🖥️ 开始服务器部署流程..."
log "📋 npm依赖安装模式："
if [ "$INSTALL_NPM" = true ]; then
    log "   📦 安装npm依赖"
else
    log "   ⏭️  跳过npm依赖安装"
fi

log "📋 数据清理模式："
if [ "$CLEAR_DATA" = true ]; then
    log "   🗑️  清理所有数据（数据库、文件、队列）"
else
    log "   💾 保留现有数据"
fi
log ""

# ========================== 服务器环境准备 ==========================
log "🛠️ 服务器环境准备..."

# 创建必要的目录结构
log "📁 创建目录结构..."
mkdir -p storage-local/processed/original storage-local/processed/highres storage-local/processed/thumbnail storage-local/processing/failed storage-local/upload logs

# 检查并安装Redis
log "🔍 检查Redis服务..."
if ! command -v redis-cli &> /dev/null; then
    log '📦 Redis未安装，开始安装...'
    log ''
    if [ -n "$SUDO_PASSWORD" ]; then
        log '🔐 使用提供的sudo密码安装Redis...'
        echo "$SUDO_PASSWORD" | sudo -S apt update
        echo "$SUDO_PASSWORD" | sudo -S apt install -y redis-server
        echo "$SUDO_PASSWORD" | sudo -S systemctl start redis-server
        echo "$SUDO_PASSWORD" | sudo -S systemctl enable redis-server
    else
        log '🔐 ==============================================='
        log '⚠️  需要输入sudo密码来安装Redis'
        log '🔐 请在下面输入你的sudo密码：'
        log '🔐 ==============================================='
        log ''
        sudo apt update
        sudo apt install -y redis-server
        sudo systemctl start redis-server
        sudo systemctl enable redis-server
    fi
    log '✅ Redis安装完成'
else
    log '✅ Redis已安装'
fi

# 检查Redis服务状态
log "🔍 检查Redis服务状态..."
if systemctl is-active --quiet redis-server; then
    log '✅ Redis服务正在运行'
else
    log '⚠️  Redis服务未运行，尝试启动...'
    sudo systemctl start redis-server
fi

# ========================== 依赖管理 ==========================
if [ "$INSTALL_NPM" = true ]; then
    log "📦 安装依赖和修复Sharp..."
    log "📦 安装npm依赖..."
    log '🧹 清理npm缓存...'
    npm cache clean --force
    log '📦 安装npm依赖...'
    npm install --production
    log '✅ npm依赖安装完成'
    
    # 修复Sharp模块（仅在安装npm依赖时执行）
    log "🔧 修复Sharp模块（包含系统库安装）..."
    bash "$(dirname "$0")/fix-sharp-complete.sh"
else
    log "📦 跳过依赖管理..."
    log "⏭️ 跳过npm依赖安装"
    log "⏭️ 跳过Sharp模块修复"
fi

# 安装PM2（如果未安装）
log "📦 检查并安装PM2..."
if ! command -v pm2 &> /dev/null; then
    log '📦 PM2未安装，开始全局安装...'
    log ''
    if [ -n "$SUDO_PASSWORD" ]; then
        log '🔐 使用提供的sudo密码安装PM2...'
        echo "$SUDO_PASSWORD" | sudo -S npm install -g pm2
    else
        log '🔐 ==============================================='
        log '⚠️  需要输入sudo密码来安装PM2'
        log '🔐 请在下面输入你的sudo密码：'
        log '🔐 ==============================================='
        log ''
        sudo npm install -g pm2
    fi
    log '✅ PM2安装完成'
else
    log '✅ PM2已安装'
fi


# ========================== 数据清理（可选） ==========================
if [ "$CLEAR_DATA" = true ]; then
    log "🗑️ 清理所有数据..."
    
    # 清理所有数据（存储文件、队列、Redis）
    log "📊 清理所有数据..."
    if node "$(dirname "$0")/../development/clear-image-data.js" --clear-all; then
        log "✅ 所有数据清理完成"
    else
        log "❌ 数据清理失败"
        exit 1
    fi
else
    log "⏭️ 跳过数据清理，保留现有数据"
fi

# ========================== 数据库操作 ==========================
if [ "$REBUILD_DB" = true ]; then
    log "🗄️ 重建数据库..."
    log "📊 重建数据库表..."
    
    if node "$(dirname "$0")/rebuild-database.js"; then
        log "✅ 数据库重建完成"
    else
        log "❌ 数据库重建失败"
        exit 1
    fi
elif [ "$INIT_DB" = true ]; then
    log "🗄️ 初始化数据库..."
    log "📊 创建数据库表..."
    if node "$(dirname "$0")/rebuild-database.js"; then
        log "✅ 数据库初始化完成"
    else
        log "❌ 数据库初始化失败"
        exit 1
    fi
else
    log "🗄️ 跳过数据库操作..."
    log "⏭️ 未指定数据库操作参数，跳过数据库初始化"
fi

# ========================== 服务管理 ==========================
log "🚀 启动服务..."

# 停止现有服务
log "⏹️ 停止现有服务..."
pm2 stop all || true

# 删除现有服务
log "🗑️ 删除现有服务..."
pm2 delete all || true

# 启动新服务
log "🚀 启动新服务..."
pm2 start "$(dirname "$0")/../../ecosystem.config.js"

# 保存PM2配置
log "💾 保存PM2配置..."
pm2 save

# ========================== 验证部署 ==========================
log "🧪 验证部署..."

# 等待服务启动
log "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
log "📊 检查服务状态..."
pm2 status

log ""
log "🎉 服务器部署完成！"
log ""
log "📋 部署总结："
log "✅ Redis服务安装和启动"
log "✅ PM2进程管理器安装"
if [ "$INSTALL_NPM" = true ]; then
    log "✅ Sharp模块修复"
fi
if [ "$CLEAR_DATA" = true ]; then
    log "✅ 数据清理（数据库、文件、队列）"
fi
if [ "$INIT_DB" = true ]; then
    log "✅ 数据库初始化"
fi
if [ "$REBUILD_DB" = true ]; then
    log "✅ 数据库重建"
fi
log "✅ 数据库表创建"
log "✅ 目录结构创建"
log "✅ 服务启动和配置"
log ""
log "🌐 你的API现在可以通过以下地址访问："
log "   https://photos.bingbingcloud.com/auth/loginOrRegister"
log "   https://photos.bingbingcloud.com/images/queryAllByPage"
log ""
log "📝 常用PM2命令："
log "   pm2 status          # 查看服务状态"
log "   pm2 logs            # 查看服务日志"
log "   pm2 restart all     # 重启所有服务"
log "   pm2 stop all        # 停止所有服务"
log ""
log "📄 服务器部署日志已保存到: \$LOG_FILE"
