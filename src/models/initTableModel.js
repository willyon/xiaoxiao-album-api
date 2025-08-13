/*
 * @Author: zhangshouchang
 * @Date: 2025-08-13 09:10:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:17:08
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

// 创建images表格
// 外键（FOREIGN KEY）的作用是为了：
// 	•	数据一致性（防止插入无效的 user_id） 只有当这个user_id在users 表中有对应的id时 才允许插入这条数据
// 	•	级联操作支持（比如删除用户时自动删掉图片）
function createTableImages() {
  const createtablestmt = `
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      originalImageUrl TEXT,
      bigHighQualityImageUrl TEXT,
      bigLowQualityImageUrl TEXT,
      previewImageUrl TEXT,
      creationDate INTEGER,
      hash TEXT UNIQUE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `;

  try {
    db.prepare(createtablestmt).run();
  } catch (err) {
    console.error("创建 images 表失败：", err.message);
    throw err;
  }

  try {
    // 创建复合索引：在同一棵索引树里，按照多个列的组合顺序来建立排序和查找的加速器。 这里作用就是：按user_id排， 然后在user_id的下按照creationDate排好序
    db.prepare(
      `
        CREATE INDEX IF NOT EXISTS idx_images_userid_creationdate
        ON images(user_id, creationDate);
      `,
    ).run();
  } catch (err) {
    console.error("创建images表user_id索引失败：", err.message);
    throw err;
  }
}
module.exports = {
  deleteTableUsers,
  createTableUsers,
  deleteTableImages,
  createTableImages,
};
