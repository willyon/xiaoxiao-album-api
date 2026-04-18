/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:41:10
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 00:19:32
 * @Description: File description
 */
const authModel = require('../models/authModel')
const bcrypt = require('bcrypt') // 一个密码哈希函数库，它主要用于加密存储用户密码。 这种加密方式是不可逆的，也就是无法还原原始密码，专门用于密码安全存储。
// const crypto = require("crypto"); // node.js内置加密库 用于生成随机字符串、对称/非对称加密、生成哈希等加密操作
const nodemailer = require('nodemailer')
const { getRedisClient } = require('./redisClient')
const jwt = require('jsonwebtoken')
const CustomError = require('../errors/customError')
const { validateEmail, validatePassword } = require('../utils/validators')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * 生成访问令牌（JWT）。
 * @param {number|string} userId - 用户 ID。
 * @returns {string} JWT 字符串。
 */
const generateJWTToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1h' })
}

/**
 * 生成并缓存刷新令牌。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<string>} 刷新令牌。
 */
async function generateAndStoreRefreshToken(userId) {
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' })
  try {
    const redisClient = getRedisClient()
    const redisKey = `refresh_token_${userId}`
    const ttl = parseInt(process.env.JWT_REFRESH_EXPIRES_IN_MS) / 1000 //过期时间（单位秒） 用于redis 与cookie httponly过期时间保持一致
    await redisClient.set(redisKey, refreshToken, 'EX', ttl)
  } catch (error) {
    console.warn('Redis error: 存储 refresh token 失败，将继续返回 token', error)
  }
  return refreshToken
}

/**
 * 通过邮箱查询用户信息。
 * @param {string} email - 用户邮箱。
 * @returns {Promise<object|null>} 用户信息或 null。
 */
const getUserInfoByEmail = async (email) => {
  const user = await authModel.findUserByEmail(email)
  return user // 直接返回查询结果，可能为 null
}

/**
 * 通过用户 ID 查询用户信息。
 * @param {number|string} userId - 用户 ID。
 * @returns {Promise<object|null>} 用户信息或 null。
 */
const getUserInfoById = async (userId) => {
  const user = await authModel.findUserById(userId)
  return user // 直接返回查询结果，可能为 null
}

/**
 * 校验输入密码与哈希密码是否匹配。
 * @param {string} inputPassword - 输入密码。
 * @param {string} hashedPassword - 哈希密码。
 * @returns {Promise<boolean>} 是否匹配。
 */
const validateInputPassword = async (inputPassword, hashedPassword) => {
  try {
    return await bcrypt.compare(inputPassword, hashedPassword)
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.COMPARE_PASSWORD_ERROR,
      messageType: 'error'
    })
  }
}

// 生成不可逆加密密码 用于存储于数据库
/**
 * 哈希密码。
 * @param {string} password - 明文密码。
 * @returns {Promise<string>} 哈希密码。
 */
const _hashPassword = async (password) => {
  return await bcrypt.hash(password, 10)
}

/**
 * 创建新用户并生成邮箱验证令牌。
 * @param {{email:string,password:string}} payload - 注册参数。
 * @returns {Promise<object>} 新建用户对象。
 */
const createNewUser = async ({ email, password }) => {
  // 验证邮箱和密码格式
  validateEmail(email)
  validatePassword(password)

  // 加密密码
  const hashedPassword = await _hashPassword(password)

  // 创建新用户
  const newUser = await authModel.insertUser(email, hashedPassword)

  // 生成邮箱验证 token
  const verificationJWTToken = generateJWTToken(newUser.id)

  // 更新验证 token
  await authModel.updateUserVerificationToken(newUser.id, verificationJWTToken)

  // 更新用户状态
  await authModel.updateUserStatus(newUser.id, 'pending')

  // 添加 token 到返回对象
  newUser.verificationJWTToken = verificationJWTToken

  return newUser
}

/**
 * 校验并解析邮箱验证 JWT。
 * @param {string} token - 验证令牌。
 * @returns {{userId:number|string,exp:number,iat:number}} 解码载荷。
 */
const _verifyJWTToken = (token) => {
  const secretKey = process.env.JWT_SECRET
  // 返回解码后的数据，例如 { userId: 123, exp: 1670815945 }
  return jwt.verify(token, secretKey)
}

/**
 * 校验邮箱激活令牌并激活账户。
 * @param {string} token - 邮箱验证令牌。
 * @returns {Promise<void>} 无返回值。
 */
const verifyEmail = async (token) => {
  try {
    if (!token)
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_REQUIRED,
        messageType: 'error'
      })

    // 验证 JWT Token 是否有效
    const { userId } = _verifyJWTToken(token)

    // 在数据库中查找与 userId 匹配的用户
    const user = await authModel.findUserById(userId)
    if (!user) throw new CustomError({ httpStatus: 404, messageCode: ERROR_CODES.ACCOUNT_NOT_FOUND, messageType: 'error' })

    // 如果用户的 verifiedStatus 不是 "pending"，抛出错误
    if (user.verifiedStatus === 'active') {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.ACCOUNT_ALREADY_ACTIVE,
        messageType: 'warning'
      })
    } else if (user.verifiedStatus === 'deactivated') {
      // 已注销
      throw new CustomError({
        httpStatus: 403,
        messageCode: ERROR_CODES.ACCOUNT_CANNOT_BE_VERIFIED,
        messageType: 'error'
      })
    }

    // 更新用户的 verifiedStatus 为 "active"
    await authModel.updateUserStatus(user.id, 'active')

    // 清空用户的 verificationToken
    await authModel.updateVerificationTokenToNull(user.id)
  } catch (error) {
    // 这里的错误将传递给 Controller 中的 catch
    if (error.name === 'TokenExpiredError') {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_INVALID,
        messageType: 'error'
      })
    } else if (error.name === 'JsonWebTokenError') {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.VERIFICATION_TOKEN_INVALID,
        messageType: 'error'
      })
    } else {
      throw error
    }
  }
}

/**
 * 重新发送验证邮件。
 * @param {{email:string,req:import('express').Request}} payload - 邮件参数。
 * @returns {Promise<{email:string}>} 返回邮箱信息。
 */
const resendVerificationEmail = async ({ email, req }) => {
  validateEmail(email) // 验证 email 格式
  const user = await authModel.findUserByEmail(email)
  if (!user) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.ACCOUNT_NOT_FOUND,
      messageType: 'error'
    })
  }

  // 如果用户的状态是 "active"，不需要发送激活邮件
  if (user.verifiedStatus === 'active') {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.ACCOUNT_ALREADY_ACTIVE,
      messageType: 'warning'
    })
  }

  // 生成新的 token
  const newVerificationJWTToken = generateJWTToken(user.id)

  // 更新数据库中的用户 token
  try {
    await authModel.updateUserVerificationToken(user.id, newVerificationJWTToken)
  } catch {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.UPDATE_VERIFICATION_TOKEN_ERROR,
      messageType: 'error'
    })
  }

  // 重新发送验证邮件
  await sendVerificationEmail({ email, JWTToken: newVerificationJWTToken, language: req.userLanguage })

  return { email }
}

/**
 * 发送邮箱验证邮件。
 * @param {{email:string,JWTToken:string,language:string}} payload - 邮件参数。
 * @returns {Promise<void>} 无返回值。
 */
const sendVerificationEmail = async ({ email, JWTToken, language }) => {
  validateEmail(email)

  // 动态生成邮件内容
  const emailContent = _getEmailContent(language, JWTToken)

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true, // 使用SSL加密
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  })

  const mailOptions = {
    from: `${emailContent.mailName} <${process.env.EMAIL_USER}>`,
    to: email,
    subject: emailContent.subject, // 使用根据语言生成的标题
    html: emailContent.html // 使用根据语言生成的HTML
  }

  try {
    await transporter.sendMail(mailOptions)
  } catch (error) {
    // 邮箱地址无效 无法发送激活信息
    if (error.message.includes('550') || error.message.toLowerCase().includes('not found')) {
      throw new CustomError({
        httpStatus: 422,
        messageCode: ERROR_CODES.SEND_ACTIVATION_EMAIL_FAILED,
        messageType: 'error'
      })
    } else {
      throw new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.SEND_MAIL_ERROR,
        messageType: 'error'
      })
    }
  }
}

/**
 * 构建邮箱验证邮件内容。
 * @param {string} language - 语言代码。
 * @param {string} JWTToken - 邮箱验证令牌。
 * @returns {{mailName:string,subject:string,html:string}} 邮件内容。
 */
const _getEmailContent = (language, JWTToken) => {
  // 根据环境变量确定域名
  const baseUrl = process.env.NODE_ENV === 'development' ? 'http://localhost:5173' : 'https://photos.bingbingcloud.com'

  // 这里定义多语言的标题和正文内容
  const content = {
    en: {
      mailName: 'Xiaoxiao Album',
      subject: 'Activate Your Account for Xiaoxiao Album',
      html: `
        <h1>Welcome to Xiaoxiao Album!</h1>
        <p>Your private photo/video storage and management platform.</p>
        <p>Click the button below to activate your account:</p>
        <a href="${baseUrl}/emailActivation?token=${JWTToken}&lang=en" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          Activate Account
        </a>
        <p>If you did not register for this account, please ignore this email.</p>
      `
    },
    zh: {
      mailName: '笑启相册',
      subject: '激活您的笑启相册账户',
      html: `
        <h1>欢迎注册笑启相册！</h1>
        <p>私人照片/视频存储与管理平台</p>
        <p>点击下面的按钮以激活您的账户：</p>
        <a href="${baseUrl}/emailActivation?token=${JWTToken}&lang=zh" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          激活账户
        </a>
        <p>如果您未注册过此账户，请忽略此邮件。</p>
      `
    }
  }

  // 如果语言不存在，使用默认的 `zh`
  return content[language] || content.zh
}

// 密码重置：生成短期 JWT 并存入 Redis，过期时间 15 分钟
const PASSWORD_RESET_TOKEN_EXPIRY = '15m'
const PASSWORD_RESET_REDIS_TTL = 15 * 60 // 秒

/**
 * 生成密码重置令牌。
 * @param {number|string} userId - 用户 ID。
 * @returns {string} 密码重置令牌。
 */
const generatePasswordResetToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: PASSWORD_RESET_TOKEN_EXPIRY })
}

/**
 * 发起密码重置流程。
 * @param {string} email - 用户邮箱。
 * @param {import('express').Request} req - 请求对象。
 * @returns {Promise<void>} 无返回值。
 */
const requestPasswordReset = async (email, req) => {
  validateEmail(email)
  const user = await authModel.findUserByEmail(email)
  if (!user || user.verifiedStatus !== 'active') {
    return // 不暴露用户是否存在，统一返回成功由 controller 处理
  }
  const token = generatePasswordResetToken(user.id)
  const redisClient = getRedisClient()
  const redisKey = `password_reset:${token}`
  await redisClient.set(redisKey, String(user.id), 'EX', PASSWORD_RESET_REDIS_TTL)
  await sendPasswordResetEmail({ email, token, language: req.userLanguage })
}

/**
 * 发送密码重置邮件。
 * @param {{email:string,token:string,language:string}} payload - 邮件参数。
 * @returns {Promise<void>} 无返回值。
 */
const sendPasswordResetEmail = async ({ email, token, language }) => {
  validateEmail(email)
  const emailContent = _getPasswordResetEmailContent(language, token)
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  })
  const mailOptions = {
    from: `${emailContent.mailName} <${process.env.EMAIL_USER}>`,
    to: email,
    subject: emailContent.subject,
    html: emailContent.html
  }
  try {
    await transporter.sendMail(mailOptions)
  } catch (error) {
    if (error.message.includes('550') || error.message.toLowerCase().includes('not found')) {
      throw new CustomError({
        httpStatus: 422,
        messageCode: ERROR_CODES.SEND_ACTIVATION_EMAIL_FAILED,
        messageType: 'error'
      })
    }
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.SEND_MAIL_ERROR,
      messageType: 'error'
    })
  }
}

/**
 * 构建密码重置邮件内容。
 * @param {string} language - 语言代码。
 * @param {string} token - 重置令牌。
 * @returns {{mailName:string,subject:string,html:string}} 邮件内容。
 */
const _getPasswordResetEmailContent = (language, token) => {
  const baseUrl = process.env.NODE_ENV === 'development' ? 'http://localhost:5173' : 'https://photos.bingbingcloud.com'
  const content = {
    en: {
      mailName: 'Bingbing Cloud Photos',
      subject: 'Reset Your Password',
      html: `
        <h1>Reset Your Password</h1>
        <p>Click the button below to set a new password:</p>
        <a href="${baseUrl}/resetPassword?token=${encodeURIComponent(token)}&lang=en" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          Reset Password
        </a>
        <p>This link will expire in 15 minutes. If you did not request this, please ignore this email.</p>
      `
    },
    zh: {
      mailName: '冰冰云相册',
      subject: '重置您的密码',
      html: `
        <h1>重置密码</h1>
        <p>点击下面的按钮设置新密码：</p>
        <a href="${baseUrl}/resetPassword?token=${encodeURIComponent(token)}&lang=zh" 
          style="display:inline-block;padding:10px 20px;background-color:#409eff;color:#fff;text-decoration:none;border-radius:4px;">
          重置密码
        </a>
        <p>该链接 15 分钟内有效。如非本人操作，请忽略此邮件。</p>
      `
    }
  }
  return content[language] || content.zh
}

/**
 * 确认密码重置并更新新密码。
 * @param {string} token - 重置令牌。
 * @param {string} newPassword - 新密码。
 * @returns {Promise<void>} 无返回值。
 */
const confirmPasswordReset = async (token, newPassword) => {
  if (!token) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.RESET_TOKEN_INVALID_OR_EXPIRED,
      messageType: 'error'
    })
  }
  validatePassword(newPassword)
  const redisClient = getRedisClient()
  const redisKey = `password_reset:${token}`
  const userId = await redisClient.get(redisKey)
  if (!userId) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.RESET_TOKEN_INVALID_OR_EXPIRED,
      messageType: 'error'
    })
  }
  const hashedPassword = await _hashPassword(newPassword)
  await authModel.updatePassword(Number(userId), hashedPassword)
  await redisClient.del(redisKey)
}

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
  sendVerificationEmail,
  resendVerificationEmail,
  requestPasswordReset,
  confirmPasswordReset
  // findUserByToken,
  // activateUserAccount,
}
