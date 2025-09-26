/*
 * @Author: zhangshouchang
 * @Date: 2025-08-13 09:10:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:46:14
 * @Description: File description
 */
const { db } = require("../services/database");
//删除users表格
function deleteTableUsers() {
  const createtablestmt = `
    DROP TABLE users
  `;
  db.prepare(createtablestmt).run();
}

//创建users表格
function createTableUsers() {
  const createtablestmt = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      verified_status TEXT DEFAULT 'pending',
      verification_token TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
  `;
  try {
    db.prepare(createtablestmt).run();
  } catch (err) {
    console.error("创建 users 表失败：", err.message);
    throw err;
  }
}

//删除images表格
function deleteTableImages() {
  const createtablestmt = `
    DROP TABLE images
  `;
  db.prepare(createtablestmt).run();
}

// 创建images表格（带物化年月与索引优化）
// 外键（FOREIGN KEY）的作用是为了：
// 	•	数据一致性（防止插入无效的 user_id） 只有当这个user_id在users 表中有对应的id时 才允许插入这条数据
// 	•	级联操作支持（比如删除用户时自动删掉图片）
function createTableImages() {
  try {
    // 1) 表结构
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        original_storage_key TEXT,
        high_res_storage_key TEXT,
        thumbnail_storage_key TEXT,
        image_created_at INTEGER,              -- 毫秒时间戳，可为 NULL
        image_hash TEXT,                   -- 图片内容哈希
        year_key  TEXT DEFAULT 'unknown',                     -- 物化：'YYYY' 或 'unknown'
        month_key TEXT DEFAULT 'unknown',                     -- 物化：'YYYY-MM' 或 'unknown'
        date_key TEXT  DEFAULT 'unknown',                     -- 物化：'YYYY-MM-DD' 或 'unknown'
        day_key TEXT   DEFAULT 'unknown',                     -- 物化：'Monday' ... 或 'unknown'
        
        -- GPS 位置信息
        gps_latitude REAL,                  -- GPS纬度 (十进制格式) REAL 浮点数类型
        gps_longitude REAL,                 -- GPS经度 (十进制格式) REAL 浮点数类型
        gps_altitude REAL,                  -- GPS海拔 (米) REAL 浮点数类型
        gps_location TEXT,                  -- 位置描述 (可选，用于显示)
        country TEXT,                       -- 国家 (物化字段，用于分组查询)
        city TEXT,                          -- 城市 (物化字段，用于分组查询)
        
        -- 图片尺寸和方向信息
        width_px INTEGER,                   -- 旋正后的原图宽度
        height_px INTEGER,                  -- 旋正后的原图高度
        aspect_ratio REAL,                  -- 宽高比 (width_px / height_px)
        raw_orientation INTEGER,            -- EXIF Orientation 原值 1-8
        layout_type TEXT, -- 方向分类: 'portrait' | 'landscape' | 'square' | 'panorama' | 'unknown'
        
        -- 高清图和缩略图尺寸
        hd_width_px INTEGER,                -- 高清图实际宽度
        hd_height_px INTEGER,               -- 高清图实际高度
        thumb_width_px INTEGER,             -- 缩略图实际宽度
        thumb_height_px INTEGER,            -- 缩略图实际高度
        
        -- 存储类型信息
        storage_type TEXT,  -- 存储类型：'local', 'aliyun-oss', 's3', 'qiniu', 'cos', 'bos', 'gcs', 'azure'
        
        -- 文件信息
        file_size_bytes INTEGER,            -- 文件大小（字节）
        mime TEXT,                          -- MIME类型: 'image/jpeg' | 'image/heic' | 'image/png' | 'image/webp'
        
        -- 时间戳信息
        created_at INTEGER,                 -- 缩略图入库时间戳（毫秒）

        -- 同一用户下，内容哈希唯一（避免跨用户互相影响）
        UNIQUE (user_id, image_hash),

        -- 维护级联：删除用户自动删除其图片
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.prepare(createTableSQL).run();

    // 2) 创建核心索引（经过优化的8个核心索引）
    // 2.1 用户基础查询索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_id
      ON images(user_id);
    `,
    ).run();

    // 2.2 哈希重复检查索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_hash
      ON images(image_hash);
    `,
    ).run();

    // 2.3 用户哈希组合索引（用于更新操作）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_hash
      ON images(user_id, image_hash);
    `,
    ).run();

    // 2.4 用户创建时间索引（主要分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc
      ON images(user_id, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.5 用户年份创建时间索引（年份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year_creation
      ON images(user_id, year_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.6 用户月份创建时间索引（月份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month_creation
      ON images(user_id, month_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.7 用户存储类型创建时间索引（存储类型分组查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation
      ON images(user_id, storage_type, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.8 用户年份索引（年份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year
      ON images(user_id, year_key);
    `,
    ).run();

    // 2.9 用户月份索引（月份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month
      ON images(user_id, month_key);
    `,
    ).run();

    // 2.10 用户日期创建时间索引（日期分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_date_creation
      ON images(user_id, date_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.11 用户星期创建时间索引（星期几分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_day_creation
      ON images(user_id, day_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.12 用户日期索引（日期分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_date
      ON images(user_id, date_key);
    `,
    ).run();

    // 2.13 用户星期索引（星期几分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_day
      ON images(user_id, day_key);
    `,
    ).run();

    // 2.14 用户国家索引（国家分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_country
      ON images(user_id, country);
    `,
    ).run();

    // 2.15 用户城市索引（城市分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_city
      ON images(user_id, city);
    `,
    ).run();

    // 2.16 用户方向索引（方向筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_layout_type
      ON images(user_id, layout_type);
    `,
    ).run();

    // 2.17 用户宽高比索引（宽高比筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_aspect_ratio
      ON images(user_id, aspect_ratio);
    `,
    ).run();

    // 2.18 用户MIME类型索引（文件类型筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_mime
      ON images(user_id, mime);
    `,
    ).run();
  } catch (err) {
    console.error("创建 images 表失败：", err.message);
    throw err;
  }
}

module.exports = {
  deleteTableUsers,
  createTableUsers,
  deleteTableImages,
  createTableImages,
};
