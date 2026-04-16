/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:08:52
 * @Description: File description
 */
const { db } = require("../db");
const { mapFields } = require("../utils/fieldMapper");

const findUserById = (userId) => {
  const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
  const user = stmt.get(userId);
  return user ? mapFields("users", user) : null;
};

const findUserByEmail = (email) => {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  const user = stmt.get(email);
  return user ? mapFields("users", user) : null;
};

const insertUser = (email, password) => {
  const stmt = db.prepare("INSERT INTO users (email, password, verified_status) VALUES (?, ?, 'pending')");
  const result = stmt.run(email, password); // 执行插入操作
  const userId = result.lastInsertRowid; // 获取插入的用户ID

  // 查询并返回完整的用户信息
  const newUser = findUserById(userId);
  return newUser;
};

const updateUserVerificationToken = async (userId, newToken) => {
  const stmt = db.prepare("UPDATE users SET verification_token = ? WHERE id = ?");
  stmt.run(newToken, userId);
};

const updateUserStatus = async (userId, verifiedStatus) => {
  const stmt = db.prepare("UPDATE users SET verified_status = ? WHERE id = ?");
  stmt.run(verifiedStatus, userId);
};

const updateVerificationTokenToNull = async (userId) => {
  const stmt = db.prepare("UPDATE users SET verification_token = NULL WHERE id = ?");
  stmt.run(userId);
};

const updatePassword = async (userId, hashedPassword) => {
  const stmt = db.prepare("UPDATE users SET password = ? WHERE id = ?");
  stmt.run(hashedPassword, userId);
};

module.exports = {
  findUserById,
  findUserByEmail,
  insertUser,
  updateUserVerificationToken,
  updateUserStatus,
  updateVerificationTokenToNull,
  updatePassword,
};
