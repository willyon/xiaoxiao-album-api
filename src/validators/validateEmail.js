/*
 * @Author: zhangshouchang
 * @Date: 2024-12-30 23:41:25
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-31 16:35:41
 * @Description: File description
 */
const validator = require("validator");
const messageCodes = require("../constants/messageCodes");
const CustomError = require("../errors/customError");

function validateEmail(email) {
  if (!email || typeof email !== "string") {
    throw new CustomError({
      httpStatus: 400,
      messageCode: messageCodes.EMAIL_REQUIRED,
      message: "Email is required and must be a string.",
      messageType: "warning",
    });
  }
  if (!validator.isEmail(email)) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: messageCodes.INVALID_EMAIL_FORMAT,
      message: "Invalid email format.",
      messageType: "warning",
    });
  }
}

module.exports = validateEmail;
