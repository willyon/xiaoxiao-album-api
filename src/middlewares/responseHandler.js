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
