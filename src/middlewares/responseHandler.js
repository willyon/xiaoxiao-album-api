/*
 * @Author: zhangshouchang
 * @Date: 2025-01-01 18:00:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 00:24:27
 * @Description: File description
 */
const { setCookie } = require('../utils/cookieHelper')
const getI18nMessage = require('../i18n/getI18nMessage')
const { SUCCESS_CODES } = require('../constants/messageCodes')

/**
 * 统一响应中间件：注入 `res.sendResponse` 与 `res.setCookie`。
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @param {import('express').NextFunction} next - 下一中间件。
 * @returns {void} 无返回值。
 */
const responseHandler = (req, res, next) => {
  req.userLanguage = req.get('X-Accept-Language') || req.headers['x-accept-language'] || 'zh'

  res.sendResponse = ({
    messageCode = SUCCESS_CODES.REQUEST_COMPLETED,
    data = null,
    httpStatus = 200,
    message: customMessage,
    ...extraFields
  } = {}) => {
    const message =
      typeof customMessage === 'string' && customMessage.trim() ? customMessage.trim() : getI18nMessage(messageCode, req.userLanguage, extraFields)
    const safeStatus = Number.isInteger(httpStatus) ? httpStatus : 200
    const payload = {
      status: 'success',
      messageType: 'success',
      messageCode,
      message
    }
    if (data) payload.data = data
    res.status(safeStatus).json(payload)
  }

  res.setCookie = (name, value, options) => setCookie(res, name, value, options)

  next()
}

module.exports = {
  responseHandler
}
