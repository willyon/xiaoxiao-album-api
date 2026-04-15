/*
 * @Author: zhangshouchang
 * @Date: 2024-12-31 00:15:34
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 00:01:35
 * @Description: File description
 */
// const validator = require("validator");
const { ERROR_CODES } = require('../../constants/messageCodes')
const CustomError = require('../../errors/customError')

/**
 * Validates the given password.
 * @param {string} password - The password to validate.
 * @throws {CustomError} If the password does not meet the criteria.
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

module.exports = validatePassword
