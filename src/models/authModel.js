/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-02-15 13:54:29
 * @Description: File description
 */
const { db } = require("../services/dbService");

// 创建表格 执行成功不会返回任何值
// function createTableUsers() {
//   const createtablestmt = `
//       CREATE TABLE IF NOT EXISTS users (
//         id INTEGER PRIMARY KEY AUTOINCREMENT,
//         email TEXT NOT NULL UNIQUE,
//         password TEXT NOT NULL,
//         verifiedStatus TEXT DEFAULT 'pending',
//         verificationToken TEXT,
//         createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       );
//     `;
//   db.prepare(createtablestmt).run();
// }

const findUserById = (userId) => {
  const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
  return stmt.get(userId);
};

const findUserByEmail = (email) => {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  return stmt.get(email);
};

// const findUserByToken = (token) => {
//   const stmt = db.prepare("SELECT * FROM users WHERE verificationToken = ?");
//   return stmt.get(token);
// };

const insertUser = (email, password) => {
  const stmt = db.prepare("INSERT INTO users (email, password, verifiedStatus) VALUES (?, ?, 'pending')");
  const result = stmt.run(email, password); // 执行插入操作
  const userId = result.lastInsertRowid; // 获取插入的用户ID

  // 查询并返回完整的用户信息
  const newUser = findUserById(userId);
  return newUser;
};

// const updateUserEmailVerification = (id) => {
//   const stmt = db.prepare("UPDATE users SET isVerified = 1, verificationToken = NULL WHERE id = ?");
//   stmt.run(id);
// };

const updateUserVerificationToken = async (userId, newToken) => {
  const stmt = db.prepare("UPDATE users SET verificationToken = ? WHERE id = ?");
  stmt.run(newToken, userId);
};

const updateUserStatus = async (userId, verifiedStatus) => {
  const stmt = db.prepare("UPDATE users SET  verifiedStatus = ? WHERE id = ?");
  stmt.run(verifiedStatus, userId);
};

const updateVerificationTokenToNull = async (userId) => {
  const stmt = db.prepare("UPDATE users SET verificationToken = NULL WHERE id = ?");
  stmt.run(userId);
};

module.exports = {
  findUserById,
  findUserByEmail,
  // findUserByToken,
  insertUser,
  // updateUserEmailVerification,
  updateUserVerificationToken,
  updateUserStatus,
  updateVerificationTokenToNull,
};
