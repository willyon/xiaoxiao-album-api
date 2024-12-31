/*
 * @Author: zhangshouchang
 * @Date: 2024-12-31 00:15:34
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-31 16:36:19
 * @Description: File description
 */
const messageCodes = require("../constants/messageCodes");
const CustomError = require("../errors/customError");

/**
 * Validates the given password.
 * @param {string} password - The password to validate.
 * @throws {CustomError} If the password does not meet the criteria.
 */
function validatePassword(password) {
  if (!password || typeof password !== "string") {
    throw new CustomError({
      httpStatus: 400,
      messageCode: messageCodes.PASSWORD_REQUIRED,
      message: "Password is required and must be a string.",
      messageType: "warning",
    });
  }

  const lengthValid = password.length >= 8 && password.length <= 16;
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecialChar = /[\W_]/.test(password);

  if (!lengthValid || !hasLowercase || !hasUppercase || !hasDigit || !hasSpecialChar) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: messageCodes.PASSWORD_TOO_WEAK,
      message:
        "Password must be 8-16 characters long and include at least one uppercase letter, one lowercase letter, one digit, and one special character.",
      messageType: "warning",
    });
  }
}

module.exports = validatePassword;
