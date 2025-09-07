/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:08:52
 * @Description: File description
 */
const { db } = require("../services/dbService");

const findUserById = (userId) => {
  const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
  return stmt.get(userId);
};

const findUserByEmail = (email) => {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  return stmt.get(email);
};

const insertUser = (email, password) => {
  const stmt = db.prepare("INSERT INTO users (email, password, verifiedStatus) VALUES (?, ?, 'pending')");
  const result = stmt.run(email, password); // 执行插入操作
  const userId = result.lastInsertRowid; // 获取插入的用户ID

  // 查询并返回完整的用户信息
  const newUser = findUserById(userId);
  return newUser;
};

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
