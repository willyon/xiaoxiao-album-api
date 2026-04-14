-- 一次性迁移：将 albums.image_count 重命名为 media_count（与 API 字段 mediaCount 对齐）
-- 在已有数据库上执行一次；新建库由 initTableModel 直接创建 media_count
-- SQLite 3.25.0+ 支持 RENAME COLUMN

ALTER TABLE albums RENAME COLUMN image_count TO media_count;
