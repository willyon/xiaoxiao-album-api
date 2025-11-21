-- 清空相关表的数据
-- 用于重新生成测试数据

-- 1. 清空 images 表
DELETE FROM images;

-- 2. 清空 image_embeddings 表
DELETE FROM image_embeddings;

-- 3. 清空 cleanup_group_members 表
DELETE FROM cleanup_group_members;

-- 4. 清空 cleanup_groups 表
DELETE FROM cleanup_groups;

-- 5. 重置自增ID（可选，如果需要从1开始）
DELETE FROM sqlite_sequence WHERE name IN ('images', 'cleanup_groups', 'cleanup_group_members');

-- 完成

