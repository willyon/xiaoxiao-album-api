# Sharpness Score 字段迁移说明

## 迁移目标

1. **删除字段**：`is_blurry` 和 `blurry_probability`
2. **添加字段**：`sharpness_score`（如果不存在）
3. **删除索引**：`idx_images_user_is_blurry`

## 迁移步骤

### 方法一：使用自动化脚本（推荐）

```bash
cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service
./migrations/run_sharpness_migration.sh
```

脚本会自动：

1. 备份数据库（带时间戳）
2. 检查数据条数
3. 执行迁移
4. 验证迁移结果

### 方法二：手动执行

#### 步骤1：备份数据库

```bash
cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
sqlite3 database.db ".backup 'database.db.backup.$TIMESTAMP'"
```

#### 步骤2：执行迁移

```bash
sqlite3 database.db < migrations/migrate_sharpness_score.sql
```

#### 步骤3：验证结果

```bash
# 检查记录数
sqlite3 database.db "SELECT COUNT(*) FROM images;"

# 检查表结构
sqlite3 database.db "PRAGMA table_info(images);" | grep -E "sharpness|blurry"

# 检查索引
sqlite3 database.db "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='images';"
```

## 迁移原理

迁移采用**安全的重建表**方式：

1. **创建新表** `images_new`：
   - 包含所有原有字段（除了 `is_blurry` 和 `blurry_probability`）
   - 新增 `sharpness_score` 字段

2. **迁移数据**：
   - 从旧表 `images` 复制所有数据到新表
   - `sharpness_score` 初始化为 `NULL`（后续由业务代码填充）

3. **删除旧表**：
   - 删除旧表 `images`
   - 删除相关索引 `idx_images_user_is_blurry`

4. **重命名新表**：
   - 将 `images_new` 重命名为 `images`

## 注意事项

1. **备份文件**：备份文件会保留在项目根目录，文件名格式为 `database.db.backup.YYYYMMDD_HHMMSS`
2. **数据完整性**：迁移过程中使用事务（BEGIN TRANSACTION / COMMIT），确保数据一致性
3. **外键约束**：迁移会保留所有外键约束和唯一约束
4. **索引**：只删除 `idx_images_user_is_blurry` 索引，其他索引保持不变

## 回滚方法

如果迁移出现问题，可以使用备份文件恢复：

```bash
# 停止服务
# 恢复备份
cp database.db.backup.YYYYMMDD_HHMMSS database.db
# 重启服务
```

## 验证清单

迁移完成后，请验证：

- [ ] 记录数一致（迁移前后记录数相同）
- [ ] `sharpness_score` 字段存在
- [ ] `is_blurry` 字段已删除
- [ ] `blurry_probability` 字段已删除
- [ ] `idx_images_user_is_blurry` 索引已删除
- [ ] 备份文件已创建并保留

## 文件说明

- `backup_before_sharpness_migration.sql`：备份说明文档
- `migrate_sharpness_score.sql`：迁移 SQL 脚本
- `run_sharpness_migration.sh`：自动化迁移脚本
- `SHARPNESS_MIGRATION_README.md`：本说明文档
