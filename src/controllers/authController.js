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
const { getDefaultStorageType } = require('../constants/StorageTypes')
const asyncHandler = require('../utils/asyncHandler')
const { requireEmail, requireEmailAndPassword } = require('../utils/requestParams')

const redisClient = getRedisClient()

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

async function handleLogoutUser(req, res) {
  const refreshToken = req.cookies?.refresh_token

  if (!refreshToken) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }

  let decoded
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET)
  } catch {
    res.clearCookie('refresh_token')
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.INVALID_REFRESH_TOKEN,
      messageType: 'error'
    })
  }

  try {
    const redisKey = `refresh_token_${decoded.userId}`
    await redisClient.del(redisKey)
  } catch (redisErr) {
    console.error('Redis 清除 refresh token 失败', redisErr)
  }
  res.clearCookie('refresh_token')
  res.sendResponse({
    messageCode: SUCCESS_CODES.LOGOUT_SUCCESS
  })
}

async function handleVerifyEmail(req, res) {
  const { token } = req.query
  await authService.verifyEmail(token)
  res.sendResponse({ messageCode: SUCCESS_CODES.ACCOUNT_VERIFIED_SUCCESS })
}

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
    messageCode: 'LOGIN_SUCCESS',
    data: {
      storageType: getDefaultStorageType()
    }
  })
}

async function handleResendVerificationEmail(req, res) {
  const email = requireEmail(req.body)
  await resendEmailHandler({ req, res, email })
}

async function handleRequestPasswordReset(req, res) {
  const email = requireEmail(req.body)
  const cooldownManager = new CooldownManager(redisClient, {
    defaultCooldown: parseInt(process.env.EMAIL_COOLDOWN_SECONDS) || 60
  })
  const isCooling = await cooldownManager.isCoolingDown('password_reset', email)
  if (isCooling) {
    const remaining = await cooldownManager.getRemainingCooldown('password_reset', email)
    throw new CustomError({
      httpStatus: 429,
      messageCode: ERROR_CODES.REQUESTS_TOO_FREQUENT,
      messageType: 'warning',
      details: { retryAfterSeconds: remaining }
    })
  }
  await authService.requestPasswordReset(email, req)
  cooldownManager.setCooldown('password_reset', email)
  return res.sendResponse({
    messageCode: SUCCESS_CODES.PASSWORD_RESET_EMAIL_SENT
  })
}

async function handleConfirmPasswordReset(req, res) {
  const { token, newPassword } = req.body
  await authService.confirmPasswordReset(token, newPassword)
  return res.sendResponse({
    messageCode: SUCCESS_CODES.PASSWORD_RESET_SUCCESS
  })
}

const resendEmailHandler = async ({ req, res, email }) => {
  const cooldownManager = new CooldownManager(redisClient, { defaultCooldown: parseInt(process.env.EMAIL_COOLDOWN_SECONDS) })
  const isCooling = await cooldownManager.isCoolingDown('email', email)
  if (isCooling) {
    const remaining = await cooldownManager.getRemainingCooldown('email', email)
    throw new CustomError({
      httpStatus: 429,
      messageCode: ERROR_CODES.REQUESTS_TOO_FREQUENT,
      messageType: 'warning',
      details: {
        retryAfterSeconds: remaining
      }
    })
  }

  await authService.resendVerificationEmail({ email, req })
  cooldownManager.setCooldown('email', email)
  res.sendResponse({ messageCode: SUCCESS_CODES.EMAIL_VERIFICATION_RESENT })
}

async function handleRefreshToken(req, res) {
  const refreshToken = req.cookies?.refresh_token
  if (!refreshToken) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET)
  const userId = decoded.userId

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
