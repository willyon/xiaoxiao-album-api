/*
 * @Description: 桌面/Electron 专用认证入口，与 Web 表单登录的 authController 分离以降低侵入
 */
const authService = require('../services/authService')
const CustomError = require('../errors/customError')
const { SUCCESS_CODES, ERROR_CODES } = require('../constants/messageCodes')
const { getDefaultStorageType } = require('../constants/storageTypes')
const asyncHandler = require('../utils/asyncHandler')
const { isDesktopBootstrapAllowed } = require('../utils/desktopBootstrapGuard')

/**
 * Electron 静默会话：仅签发 **无 `exp` 的 access JWT**（桌面专用）；不签发 refresh、不写 Cookie。
 * Web 登录仍走 `POST /api/auth/session`（有 exp + refresh）。需在环境变量配置 `DESKTOP_LOCAL_USER_EMAIL`（库中已激活用户）。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function handleDesktopBootstrap(req, res) {
  if (!isDesktopBootstrapAllowed(req)) {
    throw new CustomError({
      httpStatus: 403,
      messageCode: ERROR_CODES.UNSUPPORTED_OPERATION,
      messageType: 'error'
    })
  }

  const email = process.env.DESKTOP_LOCAL_USER_EMAIL
  if (!email || !String(email).trim()) {
    throw new CustomError({
      httpStatus: 500,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }

  const existingUser = await authService.getUserInfoByEmail(String(email).trim())
  if (!existingUser || existingUser.verifiedStatus !== 'active') {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.ACCOUNT_NOT_FOUND,
      messageType: 'error'
    })
  }

  const jwtToken = authService.generateJWTToken(existingUser.id, { noExpiry: true })

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

module.exports = {
  handleDesktopBootstrap: asyncHandler(handleDesktopBootstrap)
}
