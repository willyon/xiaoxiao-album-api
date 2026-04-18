/*
 * @Author: zhangshouchang
 * @Date: 2025-01-05 09:23:50
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 08:29:36
 * @Description: File description
 */
const getI18nMessage = require('../i18n/getI18nMessage')
const logger = require('../utils/logger')
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * 全局错误处理中间件：统一包装与输出错误响应。
 * @param {Error} err - 错误对象。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @param {import('express').NextFunction} _next - 下一中间件（未使用）。
 * @returns {void} 无返回值。
 */
function errorHandler(err, req, res, _next) {
  // 非 CustomError 统一包装
  if (!(err instanceof CustomError)) {
    const mapped = mapToKnownCustomError(err)
    err =
      mapped ||
      new CustomError({
        httpStatus: 500,
        messageCode: ERROR_CODES.SERVER_ERROR,
        message: err?.message,
        messageType: 'error'
      })
  }

  const lang = req.userLanguage || req.get('X-Accept-Language') || req.headers['x-accept-language'] || 'zh'
  // 透传 err 中除了 stack和name的其他字段
  const { stack: _stack, name: _name, httpStatus, messageCode, messageType, refreshable, public: publicFields, details } = err

  const safeStatus = Number.isInteger(httpStatus) ? httpStatus : 500
  const safeCode = messageCode || ERROR_CODES.SERVER_ERROR

  // 生产环境 屏蔽具体内部错误
  const messageText = getI18nMessage(safeCode, lang, details)

  //======== 构建请求信息 用于写入错误日志 ============//
  logger.error({
    messageToUserI18n: messageText, // 返给用户看的文案
    code: safeCode,
    details, // 结构化上下文，便于检索
    message: `[${safeCode}] ${toSafeString(err.message) || getI18nMessage(safeCode, 'en', details)}`, //真正错误信息 供排查问题
    stack: err.stack,
    requestInfo: {
      method: req.method,
      headers: req.headers, // consider redacting auth/cookies
      body: req.body,
      query: req.query
    }
  })
  //======== 构建请求信息 用于写入错误日志 ============//

  // 返回统一的错误响应
  const payload = {
    status: 'error',
    messageType,
    message: messageText
  }
  if (typeof refreshable === 'boolean') payload.refreshable = refreshable
  if (publicFields && typeof publicFields === 'object') {
    Object.assign(payload, publicFields)
  }
  res.status(safeStatus).json(payload)
}

// 将常见的非 CustomError 映射为更合理的 HTTP 状态码与错误码
/**
 * 将常见原生错误映射为 `CustomError`。
 * @param {any} err - 原始错误对象。
 * @returns {CustomError|null} 映射后的错误或 null。
 */
const mapToKnownCustomError = (err) => {
  if (err && err.type === 'entity.parse.failed') {
    // JSON 解析失败（express.json/body-parser）
    return new CustomError({
      message: err?.message,
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning',
      details: { reason: 'invalid_json' }
    })
  } else if (err && err.code === 'ECONNREFUSED' && /redis/i.test(err.message || '')) {
    //Redis 连接失败 / 服务不可用
    return new CustomError({
      message: err?.message,
      httpStatus: 503,
      messageCode: ERROR_CODES.SERVER_ERROR,
      messageType: 'error',
      details: { service: 'redis' }
    })
  } else if (err && err.code === 'ENOENT') {
    // 文件不存在 典型特征：err.code === 'ENOENT'
    return new CustomError({
      message: err?.message,
      httpStatus: 404,
      messageCode: ERROR_CODES.FILE_NOT_FOUND,
      messageType: 'warning',
      details: { path: err.path }
    })
  } else if (err && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET')) {
    // 网络超时 / 连接被重置   err.code === 'ETIMEDOUT' → 504；err.code === 'ECONNRESET' → 502
    const isTimeout = err.code === 'ETIMEDOUT'
    return new CustomError({
      message: err?.message,
      httpStatus: isTimeout ? 504 : 502,
      messageCode: isTimeout ? ERROR_CODES.NETWORK_TIMEOUT : ERROR_CODES.BAD_GATEWAY,
      messageType: 'error',
      details: { reason: isTimeout ? 'timeout' : 'connection_reset' }
    })
  }
  // 其它未知错误：返回 null，交由调用处兜底为 500
  return null
}

/**
 * 安全转换任意值为字符串，超长截断。
 * @param {unknown} v - 原始值。
 * @param {number} [max=2000] - 最大长度。
 * @returns {string} 安全字符串。
 */
const toSafeString = (v, max = 2000) => {
  if (v == null) return '' //v为null或undefined时执行
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s
  } catch {
    return String(v)
  }
}
module.exports = { errorHandler }
