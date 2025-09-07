#!/bin/bash

# ========================== 服务器部署脚本 ==========================
# 在服务器上执行：环境准备、依赖安装、服务管理
#
# 使用方法：
#   ./deploy-server.sh                    # 智能安装npm依赖（默认）
#   ./deploy-server.sh --force-npm        # 强制重新安装npm依赖
#   ./deploy-server.sh --skip-npm         # 跳过npm依赖安装
#   ./deploy-server.sh --clear-data       # 清理所有数据后部署

set -e  # 遇到错误立即退出

# 创建日志文件
LOG_FILE="server-deployment-$(date +%Y%m%d-%H%M%S).log"
echo "📝 服务器部署日志将保存到: $LOG_FILE"
echo "📝 服务器部署日志将保存到: $LOG_FILE" | tee -a "$LOG_FILE"

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
            echo "  $0 --clear-data        # 清理所有数据（数据库、文件、队列）后部署"
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

# ========================== 第一步：服务器环境准备 ==========================
log "🛠️ 第一步：服务器环境准备..."

# 创建必要的目录结构
log "📁 创建目录结构..."
mkdir -p localStorage/processed/original localStorage/processed/highres localStorage/processed/thumbnail localStorage/processing/failed localStorage/upload logs

# 检查并安装Redis
log "🔍 检查Redis服务..."
if ! command -v redis-cli &> /dev/null; then
    log '📦 Redis未安装，开始安装...'
    log ''
    log '🔐 ==============================================='
    log '⚠️  需要输入sudo密码来安装Redis'
    log '🔐 请在下面输入你的sudo密码：'
    log '🔐 ==============================================='
    log ''
    sudo apt update
    sudo apt install -y redis-server
    sudo systemctl start redis-server
    sudo systemctl enable redis-server
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

# ========================== 第二步：安装依赖和修复Sharp ==========================
log "📦 第二步：安装依赖和修复Sharp..."

# 检查并安装npm依赖
if [ "$SKIP_NPM" = true ]; then
    log "⏭️ 跳过npm依赖安装"
else
    log "📦 检查npm依赖..."
    log '🔍 检查条件：'
    log '  - 强制安装: '$FORCE_NPM''
    log '  - node_modules存在: '$(test -d node_modules && echo true || echo false)''
    log '  - package-lock.json存在: '$(test -f package-lock.json && echo true || echo false)''
    log '  - package.json时间戳: '$(stat -c %Y package.json 2>/dev/null || echo 'N/A')''
    log '  - package-lock.json时间戳: '$(stat -c %Y package-lock.json 2>/dev/null || echo 'N/A')''
    log '  - package.json比package-lock.json新: '$(test package.json -nt package-lock.json 2>/dev/null && echo true || echo false)''
    
    # 检查是否需要重新安装依赖
    NEED_INSTALL=false
    
    if [ "$FORCE_NPM" = true ]; then
        NEED_INSTALL=true
        log '🔄 强制重新安装npm依赖...'
    elif [ ! -d "node_modules" ]; then
        NEED_INSTALL=true
        log '📦 node_modules不存在，需要安装...'
    elif [ ! -f "package-lock.json" ]; then
        NEED_INSTALL=true
        log '📦 package-lock.json不存在，需要安装...'
    elif [ "package.json" -nt "package-lock.json" ]; then
        NEED_INSTALL=true
        log '📦 package.json比package-lock.json新，需要安装...'
    else
        log '✅ npm依赖已是最新，跳过安装'
    fi
    
    if [ "$NEED_INSTALL" = true ]; then
        log '🧹 清理npm缓存...'
        npm cache clean --force
        log '📦 安装npm依赖...'
        npm install --production
        log '✅ npm依赖安装完成'
    fi
fi

# 安装PM2（如果未安装）
log "📦 检查并安装PM2..."
if ! command -v pm2 &> /dev/null; then
    log '📦 PM2未安装，开始全局安装...'
    log ''
    log '🔐 ==============================================='
    log '⚠️  需要输入sudo密码来安装PM2'
    log '🔐 请在下面输入你的sudo密码：'
    log '🔐 ==============================================='
    log ''
    sudo npm install -g pm2
    log '✅ PM2安装完成'
else
    log '✅ PM2已安装'
fi

# 修复Sharp模块
log "🔧 修复Sharp模块（包含系统库安装）..."
bash "$(dirname "$0")/fix-sharp-complete.sh"

# ========================== 第三步：数据清理（可选） ==========================
if [ "$CLEAR_DATA" = true ]; then
    log "🗑️ 第三步：清理所有数据..."
    
    # 清理数据库和文件
    log "📊 清理数据库和文件..."
    node "$(dirname "$0")/clearAllAboutImageData.js"
    
    # 清理队列
    log "📋 清理队列..."
    node "$(dirname "$0")/clearQueues.js"
    
    log "✅ 数据清理完成"
else
    log "⏭️ 跳过数据清理，保留现有数据"
fi

# ========================== 第四步：数据库初始化 ==========================
log "🗄️ 第四步：数据库初始化..."

# 初始化数据库表
log "📊 创建数据库表..."
node "$(dirname "$0")/init-database.js"

# ========================== 第五步：服务管理 ==========================
log "🚀 第五步：启动服务..."

# 停止现有服务
log "⏹️ 停止现有服务..."
pm2 stop all || true

# 删除现有服务
log "🗑️ 删除现有服务..."
pm2 delete all || true

# 启动新服务
log "🚀 启动新服务..."
pm2 start "$(dirname "$0")/../ecosystem.config.js"

# 保存PM2配置
log "💾 保存PM2配置..."
pm2 save

# ========================== 第六步：验证部署 ==========================
log "🧪 第六步：验证部署..."

# 等待服务启动
log "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
log "📊 检查服务状态..."
pm2 status

# 测试API接口
log "🌐 测试API接口..."
curl -s -X POST -H 'Content-Type: application/json' -d '{"email":"test@example.com","password":"test123"}' http://localhost:3000/auth/loginOrRegister | head -c 200

log ""
log "🎉 服务器部署完成！"
log ""
log "📋 部署总结："
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
log "📝 常用PM2命令："
log "   pm2 status          # 查看服务状态"
log "   pm2 logs            # 查看服务日志"
log "   pm2 restart all     # 重启所有服务"
log "   pm2 stop all        # 停止所有服务"
log ""
log "📄 服务器部署日志已保存到: \$LOG_FILE"
