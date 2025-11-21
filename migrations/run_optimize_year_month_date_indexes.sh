#!/bin/bash

# 优化年份、月份、日期查询索引的迁移脚本
# 这些索引包含 deleted_at IS NULL 条件，可以显著提升查询性能

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${DB_PATH:-$PROJECT_ROOT/database.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ 数据库文件不存在: $DB_PATH"
  exit 1
fi

echo "📊 开始优化年份、月份、日期查询索引..."
echo "数据库路径: $DB_PATH"
echo ""

# 备份数据库
BACKUP_PATH="${DB_PATH}.backup.$(date +%Y%m%d_%H%M%S)"
echo "💾 备份数据库到: $BACKUP_PATH"
cp "$DB_PATH" "$BACKUP_PATH"
echo "✅ 备份完成"
echo ""

# 执行 SQL 脚本
echo "🔧 执行索引优化..."
sqlite3 "$DB_PATH" < "$SCRIPT_DIR/optimize_year_month_date_indexes.sql"

if [ $? -eq 0 ]; then
  echo "✅ 索引优化完成"
else
  echo "❌ 索引优化失败"
  exit 1
fi

echo ""
echo "📋 验证索引是否创建成功..."
sqlite3 "$DB_PATH" <<EOF
SELECT 
  name,
  sql
FROM sqlite_master 
WHERE type='index' 
  AND name IN (
    'idx_images_user_year_deleted',
    'idx_images_user_month_deleted',
    'idx_images_user_date_deleted'
  )
ORDER BY name;
EOF

echo ""
echo "✅ 迁移完成！"
echo "备份文件: $BACKUP_PATH"

