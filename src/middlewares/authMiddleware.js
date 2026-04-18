/*
 * @Author: zhangshouchang
 * @Date: 2025-02-15 00:43:34
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-09 21:37:28
 * @Description: JWT认证中间件
 */
const jwt = require('jsonwebtoken')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * JWT 鉴权中间件：校验 Bearer Token 并挂载 `req.user`。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} _res - 响应对象（未使用）。
 * @param {import('express').NextFunction} next - 下一中间件。
 * @returns {Promise<void>} 无返回值。
 */
const authMiddleware = async (req, _res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: 'error'
      })
    )
  }

  const jwtToken = authHeader.split(' ')[1]
  try {
    // 验证token的有效性（签名、过期时间）
    const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET)

    req.user = decoded // req.user格式为{userId:userId}
    next()
  } catch (jwtError) {
    if (jwtError.name === 'TokenExpiredError') {
      return next(
        new CustomError({
          httpStatus: 401,
          messageCode: ERROR_CODES.TOKEN_EXPIRED,
          messageType: 'warning',
          refreshable: true // 可尝试刷新jwt token
        })
      )
    }

    return next(
      new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.INVALID_JWT_TOKEN,
        messageType: 'error'
      })
    )
  }
}

module.exports = authMiddleware
