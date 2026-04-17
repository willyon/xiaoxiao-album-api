/*
 * @Description: 请求字段校验（邮箱、密码等）
 */
const validator = require('validator')
const { ERROR_CODES } = require('../constants/messageCodes')
const CustomError = require('../errors/customError')

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
