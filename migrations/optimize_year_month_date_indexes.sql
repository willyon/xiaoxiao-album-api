-- 优化年份、月份、日期查询的部分索引
-- 这些索引包含 deleted_at IS NULL 条件，可以显著提升查询性能

-- 优化年份查询的部分索引
-- 用于查询：WHERE user_id = ? AND year_key = ? AND deleted_at IS NULL
CREATE INDEX IF NOT EXISTS idx_images_user_year_deleted
ON images(user_id, year_key, image_created_at DESC, id DESC)
WHERE deleted_at IS NULL;

-- 优化月份查询的部分索引
-- 用于查询：WHERE user_id = ? AND month_key = ? AND deleted_at IS NULL
CREATE INDEX IF NOT EXISTS idx_images_user_month_deleted
ON images(user_id, month_key, image_created_at DESC, id DESC)
WHERE deleted_at IS NULL;

-- 优化日期查询的部分索引
-- 用于查询：WHERE user_id = ? AND date_key = ? AND deleted_at IS NULL
CREATE INDEX IF NOT EXISTS idx_images_user_date_deleted
ON images(user_id, date_key, image_created_at DESC, id DESC)
WHERE deleted_at IS NULL;

