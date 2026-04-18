/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:08:52
 * @Description: File description
 */
const { db } = require("../db");
const { mapFields } = require("../utils/fieldMapper");

/**
 * 按用户 ID 查询用户。
 * @param {number|string} userId - 用户 ID。
 * @returns {object|null} 用户对象或 null。
 */
const findUserById = (userId) => {
  const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
  const user = stmt.get(userId);
  return user ? mapFields("users", user) : null;
};

/**
 * 按邮箱查询用户。
 * @param {string} email - 邮箱地址。
 * @returns {object|null} 用户对象或 null。
 */
const findUserByEmail = (email) => {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  const user = stmt.get(email);
  return user ? mapFields("users", user) : null;
};

/**
 * 创建用户并返回完整用户信息。
 * @param {string} email - 邮箱地址。
 * @param {string} password - 哈希后的密码。
 * @returns {object|null} 新建用户对象或 null。
 */
const insertUser = (email, password) => {
  const stmt = db.prepare("INSERT INTO users (email, password, verified_status) VALUES (?, ?, 'pending')");
  const result = stmt.run(email, password); // 执行插入操作
  const userId = result.lastInsertRowid; // 获取插入的用户ID

  // 查询并返回完整的用户信息
  const newUser = findUserById(userId);
  return newUser;
};

/**
 * 更新用户邮箱验证 token。
 * @param {number|string} userId - 用户 ID。
 * @param {string} newToken - 新 token。
 * @returns {Promise<void>} 无返回值。
 */
const updateUserVerificationToken = async (userId, newToken) => {
  const stmt = db.prepare("UPDATE users SET verification_token = ? WHERE id = ?");
  stmt.run(newToken, userId);
};

/**
 * 更新用户验证状态。
 * @param {number|string} userId - 用户 ID。
 * @param {string} verifiedStatus - 验证状态。
 * @returns {Promise<void>} 无返回值。
 */
const updateUserStatus = async (userId, verifiedStatus) => {
  const stmt = db.prepare("UPDATE users SET verified_status = ? WHERE id = ?");
  stmt.run(verifiedStatus, userId);
};

/**
 * 清空用户验证 token。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<void>} 无返回值。
 */
const updateVerificationTokenToNull = async (userId) => {
  const stmt = db.prepare("UPDATE users SET verification_token = NULL WHERE id = ?");
  stmt.run(userId);
};

/**
 * 更新用户密码。
 * @param {number|string} userId - 用户 ID。
 * @param {string} hashedPassword - 哈希后的密码。
 * @returns {Promise<void>} 无返回值。
 */
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
