/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-17 03:30:49
 * @Description: File description
 */
const authModel = require("../models/authModel");
const bcrypt = require("bcrypt"); // 一个密码哈希函数库，它主要用于加密存储用户密码。 这种加密方式是不可逆的，也就是无法还原原始密码，专门用于密码安全存储。
// const crypto = require("crypto"); // node.js内置加密库 用于生成随机字符串、对称/非对称加密、生成哈希等加密操作
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const { getRedisClient } = require("../services/redisClient");
const CustomError = require("../errors/customError");

// 检查用户的冷却时间
const checkCooldown = async (email) => {
  try {
    // 获取 Redis 连接
    const redisClient = await getRedisClient();
    if (!redisClient) {
      throw new CustomError({
        httpStatus: 500,
        messageCode: "REDIS_ERROR",
        message: "server is currently unavailable, please try again later.",
        messageType: "error",
      });
    }

    const cooldownKey = `resend_email_${email}`;
    const result = await redisClient.get(cooldownKey);
    return result;
  } catch (error) {
    throw error;
  }
};

const generateJWTToken = (userId) => {
  const secretKey = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || "1h"; // 默认1小时过期

  const token = jwt.sign({ userId }, secretKey, { expiresIn });

  return token;
};

const findUserByEmail = async (email) => {
  return await authModel.findUserByEmail(email);
};

const validatePassword = async (inputPassword, hashedPassword) => {
  return await bcrypt.compare(inputPassword, hashedPassword);
};

// 生成不可逆加密密码 用于存储于数据库
const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

// 生成邮件验证链接唯一标识
// const generateVerificationToken = () => {
//   return crypto.randomBytes(32).toString("hex");
// };

const createNewUser = async (email, password) => {
  // 加密密码
  const hashedPassword = await hashPassword(password);

  // 在数据库中创建用户
  const newUser = await authModel.createUser(email, hashedPassword);

  // 生成 JWT Token (用户激活时用的验证链接)
  const verificationJWTToken = generateJWTToken(newUser.id);

  // 将生成的 token 存储到数据库的 verificationToken 字段
  await authModel.updateUserVerificationToken(newUser.id, verificationJWTToken);

  // 返回创建的用户和生成的 JWT Token
  return { user: newUser, token: verificationJWTToken };
};

const verifyJWTToken = (token) => {
  const secretKey = process.env.JWT_SECRET;
  try {
    const decoded = jwt.verify(token, secretKey);
    return decoded; // 返回解码后的数据，例如 { userId: 123, exp: 1670815945 }
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw new Error("Token 已过期");
    } else if (error.name === "JsonWebTokenError") {
      throw new Error("Token 无效");
    } else {
      throw new Error("Token 校验失败");
    }
  }
};

const verifyEmail = async (token) => {
  try {
    if (!token) throw new CustomError({ httpStatus: 400, messageCode: "TOKEN_REQUIRED", message: "token is empty", messageType: "error" });

    // 验证 JWT Token 是否有效
    const decoded = verifyJWTToken(token);
    const userId = decoded.userId;

    // 在数据库中查找与 userId 匹配的用户
    const user = await authModel.findUserById(userId);
    if (!user) throw new CustomError({ httpStatus: 404, messageCode: "ACCOUNT_NOT_FOUND", message: "user not found", messageType: "error" });

    // 如果用户的 verifiedStatus 不是 "pending"，抛出错误
    if (user.verifiedStatus === "active") {
      throw new CustomError({
        httpStatus: 400,
        messageCode: "ACCOUNT_ALREADY_ACTIVE",
        message: "Your account has been verified",
        messageType: "warning",
      });
    } else if (user.verifiedStatus === "deactivated") {
      // 已注销
      throw new CustomError({
        httpStatus: 403,
        messageCode: "ACCOUNT_CANNOT_BE_VERIFIED",
        message: "Your account has been verified",
        messageType: "error",
      });
    }

    // 更新用户的 verifiedStatus 为 "active"
    await authModel.updateUserStatus(userId, "active");

    // 清空用户的 verificationToken
    await authModel.clearVerificationToken(userId);
  } catch (error) {
    // 这里的错误将传递给 Controller 中的 catch
    if (error.name === "TokenExpiredError") {
      throw new CustomError({ httpStatus: 401, messageCode: "TOKEN_INVALID", message: "Token expired", messageType: "error" });
    } else if (error.name === "JsonWebTokenError") {
      throw new CustomError({ httpStatus: 401, messageCode: "TOKEN_INVALID", message: "Invalid Token signature", messageType: "error" });
    } else {
      throw error;
    }
  }
};

const logout = async (req) => {
  // 这里的逻辑可以清除 token
};

const resendVerificationEmail = async (email) => {
  // 查找用户
  const user = await authModel.findUserByEmail(email);
  if (!user) throw new CustomError({ httpStatus: 404, messageCode: "ACCOUNT_NOT_FOUND", message: "account not found", messageType: "error" });

  // 如果用户的状态是 "active"，不需要发送激活邮件
  if (user.verifiedStatus === "active") {
    throw new CustomError({
      httpStatus: 400,
      messageCode: "ACCOUNT_ALREADY_ACTIVE",
      message: "Your account has been verified",
      messageType: "warning",
    });
  }

  // 生成新的 token
  const newVerificationJWTToken = generateJWTToken(user.id);

  // 更新数据库中的用户 token
  await authModel.updateUserVerificationToken(user.id, newVerificationJWTToken);

  // 重新发送验证邮件
  await sendVerificationEmail(email, newVerificationJWTToken);

  // 在 Redis 中设置冷却时间
  try {
    const redisClient = await getRedisClient();
    const cooldownTime = parseInt(process.env.COOLDOWN_SECONDS, 10) || 60; // 确保将其转为整数
    await redisClient.set(`resend_email_${email}`, "1", { EX: cooldownTime });
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: "REDIS_ERROR",
      message: "server is currently unavailable, please try again later.",
      messageType: "error",
    });
  }

  return { email };
};

const sendVerificationEmail = async (email, JWTToken) => {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true, // 使用SSL加密
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"xiao album" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "请激活您的笑笑相册账户",
    html: `<a href="http://localhost:5173/verifyEmail?token=${JWTToken}">点击此处激活您的账户</a>`,
  };

  await transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("邮件发送失败:", error);
    } else {
      console.log("邮件已发送:", info.response);
    }
  });
};

const findUserByToken = async (token) => {
  return await authModel.findUserByToken(token);
};

const activateUserAccount = async (userId) => {
  return await authModel.updateUserStatus(userId, "active");
};

module.exports = {
  findUserByEmail,
  validatePassword,
  hashPassword,
  generateJWTToken,
  createNewUser,
  verifyEmail,
  logout,
  sendVerificationEmail,
  resendVerificationEmail,
  findUserByToken,
  activateUserAccount,
  checkCooldown,
};
