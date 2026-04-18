/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:31:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 00:17:47
 * @Description: File description
 */
const jwt = require('jsonwebtoken')
const authService = require('../services/authService')
const CustomError = require('../errors/customError')
const { getRedisClient } = require('../services/redisClient')
const CooldownManager = require('../services/cooldownService')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const { getDefaultStorageType } = require('../constants/storageTypes')
const asyncHandler = require('../utils/asyncHandler')
const { requireEmail, requireEmailAndPassword } = require('../utils/requestParams')
const logger = require('../utils/logger')

const redisClient = getRedisClient()
const EMAIL_COOLDOWN_SECONDS = parseInt(process.env.EMAIL_COOLDOWN_SECONDS) || 60

/**
 * 从 Cookie 提取并校验 refresh_token。
 * @param {import('express').Request} req - 请求对象。
 * @param {{clearOnInvalid?: boolean}} [options] - 校验选项。
 * @returns {{token:string,userId:number|string}} 解析后的 token 与 userId。
 */
function requireValidRefreshToken(req, { clearOnInvalid = false } = {}) {
  const token = req.cookies?.refresh_token
  if (!token) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET)
    return { token, userId: decoded.userId }
  } catch {
    if (clearOnInvalid) {
      req.res?.clearCookie('refresh_token')
    }
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.INVALID_REFRESH_TOKEN,
      messageType: 'error'
    })
  }
}

/**
 * 处理登录或注册流程，并根据账号状态返回对应结果。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleLoginOrRegister(req, res) {
  const { email, password } = requireEmailAndPassword(req.body)

  let existingUser = await authService.getUserInfoByEmail(email)

  if (!existingUser) {
    const newUser = await authService.createNewUser({ email, password })

    await authService.sendVerificationEmail({
      email,
      JWTToken: newUser.verificationJWTToken,
      language: req.userLanguage
    })

    return res.sendResponse({
      messageCode: SUCCESS_CODES.ACCOUNT_PENDING_ACTIVATION,
      httpStatus: 201
    })
  }

  const isPasswordValid = await authService.validateInputPassword(password, existingUser.password)
  if (!isPasswordValid) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PASSWORD,
      messageType: 'error'
    })
  }

  const { verifiedStatus } = existingUser

  if (verifiedStatus === 'deactivated') {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.ACCOUNT_INACTIVE,
      messageType: 'error'
    })
  } else if (verifiedStatus === 'pending') {
    await resendEmailHandler({ req, res, email })
  } else if (verifiedStatus === 'active') {
    const jwtToken = authService.generateJWTToken(existingUser.id)
    const refreshToken = await authService.generateAndStoreRefreshToken(existingUser.id)
    res.setCookie('refresh_token', refreshToken)

    return res.sendResponse({
      messageCode: SUCCESS_CODES.LOGIN_SUCCESS,
      data: {
        jwtToken,
        user: {
          email: existingUser.email
        },
        storageType: getDefaultStorageType()
      }
    })
  }
}

/**
 * 注销当前用户并清除刷新令牌。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleLogoutUser(req, res) {
  const { userId } = requireValidRefreshToken(req, { clearOnInvalid: true })

  try {
    const redisKey = `refresh_token_${userId}`
    await redisClient.del(redisKey)
  } catch (redisErr) {
    logger.warn({
      message: 'Redis 清除 refresh token 失败',
      details: { error: redisErr?.message || String(redisErr) }
    })
  }
  res.clearCookie('refresh_token')
  res.sendResponse({
    messageCode: SUCCESS_CODES.LOGOUT_SUCCESS
  })
}

/**
 * 验证邮箱激活令牌。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleVerifyEmail(req, res) {
  const { token } = req.query
  await authService.verifyEmail(token)
  res.sendResponse({ messageCode: SUCCESS_CODES.ACCOUNT_VERIFIED_SUCCESS })
}

/**
 * 检查当前 JWT 登录状态是否有效。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleCheckLoginStatus(req, res) {
  const userId = req.user.userId

  const existingUser = await authService.getUserInfoById(userId)
  if (!existingUser || existingUser.verifiedStatus !== 'active') {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }

  return res.sendResponse({
    messageCode: SUCCESS_CODES.LOGIN_SUCCESS,
    data: {
      storageType: getDefaultStorageType()
    }
  })
}

/**
 * 重新发送邮箱验证邮件。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleResendVerificationEmail(req, res) {
  const email = requireEmail(req.body)
  await resendEmailHandler({ req, res, email })
}

/**
 * 发起密码重置邮件发送请求。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleRequestPasswordReset(req, res) {
  const email = requireEmail(req.body)
  const cooldownManager = createCooldownManager()
  await assertNotCoolingDown(cooldownManager, 'password_reset', email)
  await authService.requestPasswordReset(email, req)
  cooldownManager.setCooldown('password_reset', email)
  return res.sendResponse({
    messageCode: SUCCESS_CODES.PASSWORD_RESET_EMAIL_SENT
  })
}

/**
 * 提交新密码并确认密码重置。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleConfirmPasswordReset(req, res) {
  const { token, newPassword } = req.body
  await authService.confirmPasswordReset(token, newPassword)
  return res.sendResponse({
    messageCode: SUCCESS_CODES.PASSWORD_RESET_SUCCESS
  })
}

/**
 * 执行验证邮件重发及冷却时间控制。
 * @param {{req: import('express').Request, res: import('express').Response, email: string}} payload - 重发所需参数。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
const resendEmailHandler = async ({ req, res, email }) => {
  const cooldownManager = createCooldownManager()
  await assertNotCoolingDown(cooldownManager, 'email', email)

  await authService.resendVerificationEmail({ email, req })
  cooldownManager.setCooldown('email', email)
  res.sendResponse({ messageCode: SUCCESS_CODES.EMAIL_VERIFICATION_RESENT })
}

function createCooldownManager() {
  return new CooldownManager(redisClient, { defaultCooldown: EMAIL_COOLDOWN_SECONDS })
}

async function assertNotCoolingDown(cooldownManager, scope, key) {
  const isCooling = await cooldownManager.isCoolingDown(scope, key)
  if (!isCooling) return
  const remaining = await cooldownManager.getRemainingCooldown(scope, key)
  throw new CustomError({
    httpStatus: 429,
    messageCode: ERROR_CODES.REQUESTS_TOO_FREQUENT,
    messageType: 'warning',
    details: { retryAfterSeconds: remaining }
  })
}

/**
 * 使用刷新令牌签发新的访问令牌。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleRefreshToken(req, res) {
  const { token: refreshToken, userId } = requireValidRefreshToken(req)

  const redisKey = `refresh_token_${userId}`
  const storedToken = await redisClient.get(redisKey)

  if (!storedToken || storedToken !== refreshToken) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.INVALID_REFRESH_TOKEN,
      messageType: 'error'
    })
  }

  const newJwtToken = authService.generateJWTToken(userId)
  const newRefreshToken = await authService.generateAndStoreRefreshToken(userId)
  res.setCookie('refresh_token', newRefreshToken)

  res.sendResponse({ data: { jwtToken: newJwtToken } })
}

module.exports = {
  handleLoginOrRegister: asyncHandler(handleLoginOrRegister),
  handleLogoutUser: asyncHandler(handleLogoutUser),
  handleRefreshToken: asyncHandler(handleRefreshToken),
  handleVerifyEmail: asyncHandler(handleVerifyEmail),
  handleCheckLoginStatus: asyncHandler(handleCheckLoginStatus),
  handleResendVerificationEmail: asyncHandler(handleResendVerificationEmail),
  handleRequestPasswordReset: asyncHandler(handleRequestPasswordReset),
  handleConfirmPasswordReset: asyncHandler(handleConfirmPasswordReset)
}
