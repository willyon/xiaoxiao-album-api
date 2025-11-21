-- 备份数据库（在迁移前执行）
-- 执行方式：sqlite3 database.db < backup_before_sharpness_migration.sql
-- 或者：sqlite3 database.db ".backup 'database.db.backup.$(date +%Y%m%d_%H%M%S)'"

-- 创建备份（使用 SQLite 的 .backup 命令）
-- 注意：这个文件主要用于记录备份命令，实际备份建议使用命令行：
-- sqlite3 database.db ".backup 'database.db.backup.$(date +%Y%m%d_%H%M%S)'"

-- 备份说明：
-- 1. 备份整个数据库文件（包含所有表和数据）
-- 2. 备份文件名格式：database.db.backup.YYYYMMDD_HHMMSS
-- 3. 备份文件保存在 migrations 目录或项目根目录

-- 手动备份命令（在终端执行）：
-- cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service
-- sqlite3 database.db ".backup 'database.db.backup.$(date +%Y%m%d_%H%M%S)'"

-- 或者使用 VACUUM INTO 创建备份（SQLite 3.27+）：
-- sqlite3 database.db "VACUUM INTO 'database.db.backup.$(date +%Y%m%d_%H%M%S)';"

