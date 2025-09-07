/*
 * @Author: zhangshouchang
 * @Date: 2025-08-13 09:10:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:46:14
 * @Description: File description
 */
const { db } = require("../services/dbService");
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
      verifiedStatus TEXT DEFAULT 'pending',
      verificationToken TEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        originalUrl TEXT,
        highResUrl TEXT,
        thumbnailUrl TEXT,
        creationDate INTEGER,              -- 毫秒时间戳，可为 NULL
        hash TEXT,                         -- 图片内容哈希
        yearKey  TEXT,                     -- 物化：'YYYY' 或 'unknown'
        monthKey TEXT,                     -- 物化：'YYYY-MM' 或 'unknown'
        
        -- GPS 位置信息
        gpsLatitude REAL,                  -- GPS纬度 (十进制格式) REAL 浮点数类型
        gpsLongitude REAL,                 -- GPS经度 (十进制格式) REAL 浮点数类型
        gpsAltitude REAL,                  -- GPS海拔 (米) REAL 浮点数类型
        gpsLocation TEXT,                  -- 位置描述 (可选，用于显示)
        
        -- 存储类型信息
        storageType TEXT DEFAULT 'local',  -- 存储类型：'local', 'aliyun-oss', 's3', 'qiniu', 'cos', 'bos', 'gcs', 'azure'

        -- 同一用户下，内容哈希唯一（避免跨用户互相影响）
        UNIQUE (user_id, hash),

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
      ON images(hash);
    `,
    ).run();

    // 2.3 用户哈希组合索引（用于更新操作）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_hash
      ON images(user_id, hash);
    `,
    ).run();

    // 2.4 用户创建时间索引（主要分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc
      ON images(user_id, creationDate DESC, id DESC);
    `,
    ).run();

    // 2.5 用户年份创建时间索引（年份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year_creation
      ON images(user_id, yearKey, creationDate DESC, id DESC);
    `,
    ).run();

    // 2.6 用户月份创建时间索引（月份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month_creation
      ON images(user_id, monthKey, creationDate DESC, id DESC);
    `,
    ).run();

    // 2.7 用户存储类型创建时间索引（存储类型分组查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation
      ON images(user_id, storageType, creationDate DESC, id DESC);
    `,
    ).run();

    // 2.8 用户年份索引（年份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year
      ON images(user_id, yearKey);
    `,
    ).run();

    // 2.9 用户月份索引（月份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month
      ON images(user_id, monthKey);
    `,
    ).run();
  } catch (err) {
    console.error("创建 images 表失败：", err.message);
    throw err;
  }
}

// 添加 storageType 字段到现有表（数据库迁移）
function addStorageTypeColumn() {
  try {
    // 检查字段是否已存在
    const checkColumnSQL = `
      SELECT COUNT(*) as count 
      FROM pragma_table_info('images') 
      WHERE name = 'storageType'
    `;
    const result = db.prepare(checkColumnSQL).get();

    if (result.count === 0) {
      // 字段不存在，添加字段
      const addColumnSQL = `
        ALTER TABLE images 
        ADD COLUMN storageType TEXT DEFAULT 'local'
      `;
      db.prepare(addColumnSQL).run();

      // 根据现有路径判断存储类型并更新
      const updateStorageTypeSQL = `
               UPDATE images 
               SET storageType = CASE 
                 WHEN originalUrl LIKE 'localstorage/processed/%' THEN 'local'
                 ELSE 'aliyun-oss'
               END
               WHERE storageType IS NULL OR storageType = 'local'
             `;
      db.prepare(updateStorageTypeSQL).run();

      console.log("✅ 成功添加 storageType 字段并更新现有数据");
    } else {
      console.log("ℹ️  storageType 字段已存在，跳过迁移");
    }
  } catch (err) {
    console.error("❌ 添加 storageType 字段失败：", err.message);
    throw err;
  }
}

module.exports = {
  deleteTableUsers,
  createTableUsers,
  deleteTableImages,
  createTableImages,
  addStorageTypeColumn,
};
