/*
 * @Author: zhangshouchang
 * @Date: 2024-12-30 23:41:25
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-05 10:14:07
 * @Description: File description
 */
const validator = require('validator')
const { ERROR_CODES } = require('../../constants/messageCodes')
const CustomError = require('../../errors/customError')

function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.EMAIL_REQUIRED,
      messageType: 'warning'
    })
  }
  if (!validator.isEmail(email)) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_EMAIL_FORMAT,
      messageType: 'warning'
    })
  }
}

module.exports = validateEmail
