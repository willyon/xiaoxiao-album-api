#!/bin/bash
# 执行 sharpness_score 迁移脚本
# 使用方法：./run_sharpness_migration.sh

set -e  # 遇到错误立即退出

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$PROJECT_DIR/database.db"
BACKUP_DIR="$PROJECT_DIR"

# 检查数据库文件是否存在
if [ ! -f "$DB_PATH" ]; then
    echo "错误：数据库文件不存在: $DB_PATH"
    exit 1
fi

# 生成备份文件名（带时间戳）
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/database.db.backup.$TIMESTAMP"

echo "=========================================="
echo "开始迁移 sharpness_score 字段"
echo "=========================================="
echo "数据库路径: $DB_PATH"
echo "备份文件: $BACKUP_FILE"
echo ""

# 步骤1：备份数据库
echo "步骤1：备份数据库..."
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
if [ $? -eq 0 ]; then
    echo "✅ 备份成功: $BACKUP_FILE"
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "   备份文件大小: $BACKUP_SIZE"
else
    echo "❌ 备份失败"
    exit 1
fi
echo ""

# 步骤2：检查数据条数
echo "步骤2：检查数据..."
RECORD_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM images;")
echo "   当前记录数: $RECORD_COUNT"
echo ""

# 步骤3：执行迁移
echo "步骤3：执行迁移..."
echo "   删除 is_blurry 和 blurry_probability 字段"
echo "   添加 sharpness_score 字段"
sqlite3 "$DB_PATH" < "$SCRIPT_DIR/migrate_sharpness_score.sql"
if [ $? -eq 0 ]; then
    echo "✅ 迁移成功"
else
    echo "❌ 迁移失败"
    echo "   可以使用备份文件恢复: $BACKUP_FILE"
    exit 1
fi
echo ""

# 步骤4：验证迁移结果
echo "步骤4：验证迁移结果..."
NEW_RECORD_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM images;")
if [ "$RECORD_COUNT" -eq "$NEW_RECORD_COUNT" ]; then
    echo "✅ 记录数一致: $NEW_RECORD_COUNT"
else
    echo "❌ 记录数不一致！"
    echo "   原始记录数: $RECORD_COUNT"
    echo "   迁移后记录数: $NEW_RECORD_COUNT"
    exit 1
fi

# 检查字段
HAS_SHARPNESS=$(sqlite3 "$DB_PATH" "PRAGMA table_info(images);" | grep -c "sharpness_score" || echo "0")
HAS_IS_BLURRY=$(sqlite3 "$DB_PATH" "PRAGMA table_info(images);" | grep -c "is_blurry" || echo "0")
HAS_BLURRY_PROB=$(sqlite3 "$DB_PATH" "PRAGMA table_info(images);" | grep -c "blurry_probability" || echo "0")

# 确保变量是数字
HAS_SHARPNESS=$(echo "$HAS_SHARPNESS" | tr -d '[:space:]')
HAS_IS_BLURRY=$(echo "$HAS_IS_BLURRY" | tr -d '[:space:]')
HAS_BLURRY_PROB=$(echo "$HAS_BLURRY_PROB" | tr -d '[:space:]')

if [ "$HAS_SHARPNESS" = "1" ] && [ "$HAS_IS_BLURRY" = "0" ] && [ "$HAS_BLURRY_PROB" = "0" ]; then
    echo "✅ 字段结构正确"
    echo "   - sharpness_score: 存在"
    echo "   - is_blurry: 已删除"
    echo "   - blurry_probability: 已删除"
else
    echo "❌ 字段结构不正确！"
    echo "   - sharpness_score: $([ "$HAS_SHARPNESS" = "1" ] && echo "存在" || echo "不存在")"
    echo "   - is_blurry: $([ "$HAS_IS_BLURRY" = "0" ] && echo "已删除" || echo "仍存在")"
    echo "   - blurry_probability: $([ "$HAS_BLURRY_PROB" = "0" ] && echo "已删除" || echo "仍存在")"
    exit 1
fi

# 检查索引
HAS_BLURRY_INDEX=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_images_user_is_blurry';" | wc -l)
if [ "$HAS_BLURRY_INDEX" -eq 0 ]; then
    echo "✅ 索引已删除: idx_images_user_is_blurry"
else
    echo "⚠️  警告：索引 idx_images_user_is_blurry 仍存在"
fi

echo ""
echo "=========================================="
echo "迁移完成！"
echo "=========================================="
echo "备份文件: $BACKUP_FILE"
echo "备份文件将保留，不会自动删除"
echo ""

