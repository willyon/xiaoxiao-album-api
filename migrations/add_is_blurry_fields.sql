-- 添加 is_blurry 和 blurry_probability 字段到 images 表
-- 注意：sharpness_score 字段保留但不更新（兼容旧数据）

ALTER TABLE images ADD COLUMN is_blurry INTEGER DEFAULT NULL;
ALTER TABLE images ADD COLUMN blurry_probability REAL DEFAULT NULL;

-- 创建索引以优化模糊图查询
CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry ON images(user_id, is_blurry);

