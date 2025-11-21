#!/bin/bash

# ============================================
# 优化 deleted_at 索引脚本
# ============================================
# 功能：将 idx_images_user_deleted 从普通索引改为部分索引
# ============================================

set -e  # 遇到错误立即退出

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 数据库路径（从环境变量或默认路径获取）
DB_PATH="${DB_PATH:-$PROJECT_ROOT/data/database.db}"

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}优化 deleted_at 索引${NC}"
echo -e "${YELLOW}============================================${NC}"
echo ""

# 检查数据库文件是否存在
if [ ! -f "$DB_PATH" ]; then
    echo -e "${RED}错误：数据库文件不存在: $DB_PATH${NC}"
    echo "请设置 DB_PATH 环境变量指定数据库路径，例如："
    echo "  export DB_PATH=/path/to/your/database.db"
    echo "  $0"
    exit 1
fi

echo -e "${GREEN}数据库路径: $DB_PATH${NC}"
echo ""

# 检查 sqlite3 是否安装
if ! command -v sqlite3 &> /dev/null; then
    echo -e "${RED}错误：未找到 sqlite3 命令${NC}"
    echo "请先安装 sqlite3"
    exit 1
fi

# 备份数据库（可选，但强烈推荐）
BACKUP_PATH="${DB_PATH}.backup.$(date +%Y%m%d_%H%M%S)"
echo -e "${YELLOW}正在备份数据库...${NC}"
cp "$DB_PATH" "$BACKUP_PATH"
echo -e "${GREEN}备份完成: $BACKUP_PATH${NC}"
echo ""

# 显示当前索引信息
echo -e "${YELLOW}当前索引信息:${NC}"
sqlite3 "$DB_PATH" "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_images_user_deleted';" || echo "索引不存在或已删除"
echo ""

# 执行 SQL 脚本
SQL_FILE="$SCRIPT_DIR/optimize_deleted_at_index.sql"
echo -e "${YELLOW}正在执行索引优化...${NC}"
sqlite3 "$DB_PATH" < "$SQL_FILE"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}索引优化完成！${NC}"
    echo ""
    
    # 验证索引创建结果
    echo -e "${YELLOW}验证索引创建结果:${NC}"
    sqlite3 "$DB_PATH" "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_images_user_deleted';"
    echo ""
    
    # 检查索引是否为部分索引
    INDEX_SQL=$(sqlite3 "$DB_PATH" "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_images_user_deleted';")
    if [[ "$INDEX_SQL" == *"WHERE deleted_at IS NULL"* ]]; then
        echo -e "${GREEN}✓ 部分索引创建成功！${NC}"
    else
        echo -e "${YELLOW}⚠ 警告：索引可能不是部分索引，请检查${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}完成！${NC}"
    echo -e "${GREEN}============================================${NC}"
else
    echo -e "${RED}错误：索引优化失败${NC}"
    echo -e "${YELLOW}已恢复备份: $BACKUP_PATH${NC}"
    exit 1
fi

