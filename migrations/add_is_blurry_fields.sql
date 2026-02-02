-- 方案 A：模糊图用 images.is_blurry 表示，不再使用 cleanup_groups 的 blurry 分组
-- 若 is_blurry 列已存在（例如曾运行过旧版迁移），请注释或跳过下面一行再执行本文件
ALTER TABLE images ADD COLUMN is_blurry INTEGER DEFAULT 0;

-- 2. 从现有模糊图分组回填 is_blurry
UPDATE images
SET is_blurry = 1
WHERE id IN (
  SELECT cgm.image_id
  FROM cleanup_group_members cgm
  INNER JOIN cleanup_groups cg ON cg.id = cgm.group_id
  WHERE cg.group_type = 'blurry'
);

-- 3. 删除模糊图分组成员与分组（彻底移除 blurry 分组逻辑）
DELETE FROM cleanup_group_members
WHERE group_id IN (SELECT id FROM cleanup_groups WHERE group_type = 'blurry');
DELETE FROM cleanup_groups WHERE group_type = 'blurry';

-- 4. 索引：按用户 + 是否模糊图分页查询
CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry ON images(user_id, is_blurry);
-- 索引：模糊图列表按 sharpness_score 排序
CREATE INDEX IF NOT EXISTS idx_images_user_is_blurry_sharpness ON images(user_id, is_blurry, sharpness_score);
