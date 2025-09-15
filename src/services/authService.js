/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 00:19:32
 * @Description: File description
 */
const authModel = require("../models/authModel");
const bcrypt = require("bcrypt"); // 一个密码哈希函数库，它主要用于加密存储用户密码。 这种加密方式是不可逆的，也就是无法还原原始密码，专门用于密码安全存储。
// const crypto = require("crypto"); // node.js内置加密库 用于生成随机字符串、对称/非对称加密、生成哈希等加密操作
const nodemailer = require("nodemailer");
const { getRedisClient } = require("./redisClient");
const jwt = require("jsonwebtoken");
const CustomError = require("../errors/customError");
const { validateEmail, validatePassword } = require("../utils/validators/index");
const { ERROR_CODES } = require("../constants/messageCodes");

const generateJWTToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "1h" });
};

async function generateAndStoreRefreshToken(userId) {
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d" });
  try {
    const redisClient = getRedisClient();
    const redisKey = `refresh_token_${userId}`;
    const ttl = parseInt(process.env.JWT_REFRESH_EXPIRES_IN_MS) / 1000; //过期时间（单位秒） 用于redis 与cookie httponly过期时间保持一致
    await redisClient.set(redisKey, refreshToken, "EX", ttl);
  } catch (error) {
    console.warn("Redis error: 存储 refresh token 失败，将继续返回 token", error);
  }
  return refreshToken;
}

const getUserInfoByEmail = async (email) => {
  try {
    const user = await authModel.findUserByEmail(email);
    return user; // 直接返回查询结果，可能为 null
  } catch (error) {
    throw error;
  }
};

const getUserInfoById = async (userId) => {
  try {
    const user = await authModel.findUserById(userId);
    return user; // 直接返回查询结果，可能为 null
  } catch (error) {
    throw error;
  }
};

const validateInputPassword = async (inputPassword, hashedPassword) => {
  try {
    return await bcrypt.compare(inputPassword, hashedPassword);
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.COMPARE_PASSWORD_ERROR,
      messageType: "error",
    });
  }
};

// 生成不可逆加密密码 用于存储于数据库
const _hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

const createNewUser = async ({ email, password }) => {
  try {
    // 验证邮箱和密码格式
    validateEmail(email);
    validatePassword(password);

    // 加密密码
    const hashedPassword = await _hashPassword(password);

    // 创建新用户
    const newUser = await authModel.insertUser(email, hashedPassword);

    // 生成邮箱验证 token
    const verificationJWTToken = generateJWTToken(newUser.id);

    // 更新验证 token
    await authModel.updateUserVerificationToken(newUser.id, verificationJWTToken);

    // 更新用户状态
    await authModel.updateUserStatus(newUser.id, "pending");

    // 添加 token 到返回对象
    newUser.verificationJWTToken = verificationJWTToken;

    return newUser;
  } catch (error) {
    throw error;
  }
};

const _verifyJWTToken = (token) => {
  const secretKey = process.env.JWT_SECRET;
  // 返回解码后的数据，例如 { userId: 123, exp: 1670815945 }
  return jwt.verify(token, secretKey);
};

const verifyEmail = async (token) => {
  try {
    if (!token)
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_REQUIRED,
        messageType: "error",
      });

    // 验证 JWT Token 是否有效
    const { userId } = _verifyJWTToken(token);
    console.log("解开了", userId);

    // 在数据库中查找与 userId 匹配的用户
    const user = await authModel.findUserById(userId);
    if (!user) throw new CustomError({ httpStatus: 404, messageCode: ERROR_CODES.ACCOUNT_NOT_FOUND, messageType: "error" });

    // 如果用户的 verifiedStatus 不是 "pending"，抛出错误
    if (user.verifiedStatus === "active") {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.ACCOUNT_ALREADY_ACTIVE,
        messageType: "warning",
      });
    } else if (user.verifiedStatus === "deactivated") {
      // 已注销
      throw new CustomError({
        httpStatus: 403,
        messageCode: ERROR_CODES.ACCOUNT_CANNOT_BE_VERIFIED,
        messageType: "error",
      });
    }

    // 更新用户的 verifiedStatus 为 "active"
    await authModel.updateUserStatus(user.id, "active");

    // 清空用户的 verificationToken
    await authModel.updateVerificationTokenToNull(user.id);
  } catch (error) {
    // 这里的错误将传递给 Controller 中的 catch
    if (error.name === "TokenExpiredError") {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_INVALID,
        messageType: "error",
      });
    } else if (error.name === "JsonWebTokenError") {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_INVALID,
        messageType: "error",
      });
    } else {
      throw error;
    }
  }
};

const logout = async (req) => {
  // 这里的逻辑可以清除 token
};

const resendVerificationEmail = async ({ email, req }) => {
  try {
    validateEmail(email); // 验证 email 格式
    var user = await authModel.findUserByEmail(email);
    if (!user) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.ACCOUNT_NOT_FOUND,
        messageType: "error",
      });
    }
  } catch (error) {
    throw error;
  }

  // 如果用户的状态是 "active"，不需要发送激活邮件
  if (user.verifiedStatus === "active") {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.ACCOUNT_ALREADY_ACTIVE,
      messageType: "warning",
    });
  }

  // 生成新的 token
  const newVerificationJWTToken = generateJWTToken(user.id);

  // 更新数据库中的用户 token
  try {
    await authModel.updateUserVerificationToken(user.id, newVerificationJWTToken);
  } catch (error) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.UPDATE_VERIFICATION_TOKEN_ERROR,
      messageType: "error",
    });
  }

  // 重新发送验证邮件
  try {
    await sendVerificationEmail({ email, JWTToken: newVerificationJWTToken, language: req.userLanguage });
  } catch (error) {
    throw error;
  }

  return { email };
};

const sendVerificationEmail = async ({ email, JWTToken, language }) => {
  try {
    validateEmail(email);
  } catch (error) {
    throw error;
  }

  // 动态生成邮件内容
  const emailContent = _getEmailContent(language, JWTToken);

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
    from: `${emailContent.mailName} <${process.env.EMAIL_USER}>`,
    to: email,
    subject: emailContent.subject, // 使用根据语言生成的标题
    html: emailContent.html, // 使用根据语言生成的HTML
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("邮件已发送:", info.response);
  } catch (error) {
    console.log("这是邮箱发送失败error:", error.message);
    // 邮箱地址无效 无法发送激活信息
    if (error.message.includes("550") || error.message.toLowerCase().includes("not found")) {
      throw new CustomError({
        httpStatus: 422,
        messageCode: ERROR_CODES.SEND_ACTIVATION_EMAIL_FAILED,
        messageType: "error",
      });
    } else {
      throw new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.SEND_MAIL_ERROR,
        messageType: "error",
      });
    }
  }
};

const _getEmailContent = (language, JWTToken) => {
  // 根据环境变量确定域名
  const baseUrl = process.env.NODE_ENV === "development" ? "http://localhost:5173" : "https://photos.bingbingcloud.com";

  // 这里定义多语言的标题和正文内容
  const content = {
    en: {
      mailName: "Bingbing Cloud Photos",
      subject: "Activate Your Account for Bingbing Cloud Photos",
      html: `
        <h1>Welcome to Bingbing Cloud Photos!</h1>
        <p>Click the button below to activate your account:</p>
        <a href="${baseUrl}/verifyEmail?token=${JWTToken}&lang=en" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          Activate Account
        </a>
        <p>If you did not register for this account, please ignore this email.</p>
      `,
    },
    zh: {
      mailName: "冰冰云相册",
      subject: "激活您的冰冰云相册账户",
      html: `
        <h1>欢迎注册冰冰云相册！</h1>
        <p>点击下面的按钮以激活您的账户：</p>
        <a href="${baseUrl}/verifyEmail?token=${JWTToken}&lang=zh" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          激活账户
        </a>
        <p>如果您未注册过此账户，请忽略此邮件。</p>
      `,
    },
  };

  // 如果语言不存在，使用默认的 `zh`
  return content[language] || content.zh;
};

// const findUserByToken = async (token) => {
//   return await authModel.findUserByToken(token);
// };

// const activateUserAccount = async (userId) => {
// return await authModel.updateUserStatus(userId, "active");
// };

module.exports = {
  getUserInfoByEmail,
  getUserInfoById,
  validateInputPassword,
  generateJWTToken,
  generateAndStoreRefreshToken,
  createNewUser,
  verifyEmail,
  logout,
  sendVerificationEmail,
  resendVerificationEmail,
  // findUserByToken,
  // activateUserAccount,
};
