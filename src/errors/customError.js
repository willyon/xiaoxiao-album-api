const { SERVER_ERROR } = require("../constants/messageCodes");
/*
 * @Author: zhangshouchang
 * @Date: 2024-12-16 09:29:27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-31 16:19:11
 * @Description: Custom error class
 */
class CustomError extends Error {
  /**
   * 自定义错误类的构造函数
   * @param {Object} options - 错误对象的详细信息
   * @param {number} options.httpStatus - HTTP 状态码（例如 404, 500, 403）
   * @param {string} options.messageCode - 错误的业务逻辑代码（例如 ACCOUNT_NOT_FOUND, INVALID_TOKEN）
   * @param {string} options.message - 错误的提示信息，主要用于开发和调试
   * @param {string} options.messageType - 消息类型（success, warning, error, info），用于前端弹框样式
   */
  constructor({ httpStatus = 500, messageCode = SERVER_ERROR, message = "An error occurred", messageType = "error" } = {}) {
    // 继承父类的 message 属性
    super(message);

    // 设置类的属性
    this.httpStatus = httpStatus; // HTTP 状态码
    this.messageCode = messageCode; // 业务逻辑的错误代码
    this.message = message; // 错误的提示信息
    this.messageType = messageType; // 前端的消息类型（用于前端控制弹框的样式）

    // 捕获错误调用栈，排除 constructor，这允许开发人员更轻松地调试错误的来源位置，因为错误的调用位置会被保存在栈中。
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = CustomError;
