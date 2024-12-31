/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-29 21:21:46
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

// const findUserByToken = (token) => {
//   const stmt = db.prepare("SELECT * FROM users WHERE verificationToken = ?");
//   return stmt.get(token);
// };

const insertUser = (email, password, language) => {
  const stmt = db.prepare("INSERT INTO users (email, password, language) VALUES (?, ?, ?)");
  const result = stmt.run(email, password, language); // 执行插入操作
  const userId = result.lastInsertRowid; // 获取插入的用户ID
  return { id: userId, email, password, language }; // 返回新创建用户的信息
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
