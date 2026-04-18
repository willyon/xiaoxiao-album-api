/*
 * @Description: 请求字段校验（邮箱、密码等）
 */
const validator = require('validator')
const { ERROR_CODES } = require('../constants/messageCodes')
const CustomError = require('../errors/customError')

/**
 * 校验邮箱是否存在且格式合法。
 * @param {string} email - 待校验邮箱。
 * @returns {void} 校验通过时无返回值。
 */
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

/**
 * 校验密码强度是否满足规则。
 * @param {string} password - 待校验密码。
 * @returns {void} 校验通过时无返回值。
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.PASSWORD_REQUIRED,
      messageType: 'warning'
    })
  }

  const lengthValid = password.length >= 8 && password.length <= 16
  const hasLowercase = /[a-z]/.test(password)
  const hasUppercase = /[A-Z]/.test(password)
  const hasDigit = /\d/.test(password)
  const hasSpecialChar = /[\W_]/.test(password)

  if (!lengthValid || !hasLowercase || !hasUppercase || !hasDigit || !hasSpecialChar) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.PASSWORD_TOO_WEAK,
      messageType: 'warning'
    })
  }
}

module.exports = {
  validateEmail,
  validatePassword
}
