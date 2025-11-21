#!/bin/bash
# 执行删除 is_recommended_keep 字段的迁移脚本
# 使用方法：./run_remove_is_recommended_keep.sh

set -e  # 遇到错误立即退出

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$PROJECT_DIR/database.db"
BACKUP_DIR="$PROJECT_DIR"
MIGRATION_SQL="$SCRIPT_DIR/remove_is_recommended_keep.sql"

# 检查数据库文件是否存在
if [ ! -f "$DB_PATH" ]; then
    echo "错误：数据库文件不存在: $DB_PATH"
    exit 1
fi

# 检查迁移 SQL 文件是否存在
if [ ! -f "$MIGRATION_SQL" ]; then
    echo "错误：迁移 SQL 文件不存在: $MIGRATION_SQL"
    exit 1
fi

# 生成备份文件名（带时间戳）
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/database.db.backup.$TIMESTAMP"

echo "=========================================="
echo "开始迁移：删除 is_recommended_keep 字段"
echo "=========================================="
echo "数据库路径: $DB_PATH"
echo "备份文件: $BACKUP_FILE"
echo "迁移 SQL: $MIGRATION_SQL"
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
RECORD_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM cleanup_group_members;" 2>/dev/null || echo "0")
echo "   当前 cleanup_group_members 记录数: $RECORD_COUNT"

# 检查 is_recommended_keep 字段是否存在
HAS_FIELD=$(sqlite3 "$DB_PATH" "PRAGMA table_info(cleanup_group_members);" | grep -c "is_recommended_keep" || echo "0")
if [ "$HAS_FIELD" -eq 0 ]; then
    echo "⚠️  警告：cleanup_group_members 表中不存在 is_recommended_keep 字段，可能已经迁移过了"
    echo "   是否继续？(y/N)"
    read -r CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "   已取消迁移"
        exit 0
    fi
fi
echo ""

# 步骤3：执行迁移
echo "步骤3：执行迁移..."
echo "   删除 is_recommended_keep 字段"
echo "   重建 cleanup_group_members 表"
echo "   重建索引"
sqlite3 "$DB_PATH" < "$MIGRATION_SQL"
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

# 检查记录数是否一致
NEW_RECORD_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM cleanup_group_members;")
if [ "$RECORD_COUNT" -eq "$NEW_RECORD_COUNT" ]; then
    echo "✅ 记录数一致: $NEW_RECORD_COUNT"
else
    echo "⚠️  警告：记录数不一致"
    echo "   迁移前: $RECORD_COUNT"
    echo "   迁移后: $NEW_RECORD_COUNT"
fi

# 检查 is_recommended_keep 字段是否已删除
HAS_FIELD_AFTER=$(sqlite3 "$DB_PATH" "PRAGMA table_info(cleanup_group_members);" | grep -c "is_recommended_keep" || echo "0")
if [ "$HAS_FIELD_AFTER" -eq 0 ]; then
    echo "✅ is_recommended_keep 字段已成功删除"
else
    echo "❌ 错误：is_recommended_keep 字段仍然存在"
    exit 1
fi

# 检查索引是否存在
INDEX_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_cleanup_members_group_rank', 'idx_cleanup_members_image');")
if [ "$INDEX_COUNT" -eq 2 ]; then
    echo "✅ 索引已重建: idx_cleanup_members_group_rank, idx_cleanup_members_image"
else
    echo "⚠️  警告：索引数量不正确 (期望: 2, 实际: $INDEX_COUNT)"
fi

echo ""
echo "=========================================="
echo "迁移完成！"
echo "=========================================="
echo "备份文件: $BACKUP_FILE"
echo "如需恢复，请执行: sqlite3 $DB_PATH \".restore '$BACKUP_FILE'\""
echo ""

