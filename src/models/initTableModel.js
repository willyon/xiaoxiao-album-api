/*
 * @Author: zhangshouchang
 * @Date: 2025-08-13 09:10:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 22:20:34
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
        originalImageUrl TEXT,
        bigHighQualityImageUrl TEXT,
        bigLowQualityImageUrl TEXT,
        previewImageUrl TEXT,
        creationDate INTEGER,              -- 毫秒时间戳，可为 NULL
        hash TEXT,                         -- 图片内容哈希
        yearKey  TEXT,                     -- 物化：'YYYY' 或 'unknown'
        monthKey TEXT,                     -- 物化：'YYYY-MM' 或 'unknown'

        -- 同一用户下，内容哈希唯一（避免跨用户互相影响）
        UNIQUE (user_id, hash),

        -- 维护级联：删除用户自动删除其图片
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.prepare(createTableSQL).run();

    // 2) 创建常用索引（查询/分组/排序都会用到）
    // 2.1 按用户查
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_id
      ON images(user_id);
    `,
    ).run();

    // 2.2 用户 + 拍摄时间（时间轴/分页）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_userid_creationdate
      ON images(user_id, creationDate);
    `,
    ).run();

    // 2.3 用户 + 月份键（分组/筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month
      ON images(user_id, monthKey);
    `,
    ).run();

    // 2.4 用户 + 年份键（分组/筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year
      ON images(user_id, yearKey);
    `,
    ).run();

    // 2.5 取“每组(月/年)最新一张”时的排序加速（包含 id 作为稳定次序）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month_date_id
      ON images(user_id, monthKey, creationDate, id);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year_date_id
      ON images(user_id, yearKey, creationDate, id);
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
