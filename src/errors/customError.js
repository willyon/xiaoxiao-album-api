const { ERROR_CODES } = require("../constants/messageCodes");
/*
 * @Author: zhangshouchang
 * @Date: 2024-12-16 09:29:27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-09 22:31:40
 * @Description: Custom error class
 */
class CustomError extends Error {
  /**
   * 自定义错误类的构造函数
   * @param {Object} options - 错误对象的详细信息
   * @param {number} [options.httpStatus=500] - HTTP 状态码
   * @param {string} [options.messageCode=SERVER_ERROR] - 业务逻辑错误代码（如 ACCOUNT_NOT_FOUND, INVALID_TOKEN）
   * @param {string} [options.messageType="error"] - 消息类型（success, warning, error, info），用于前端弹框样式
   * @param {boolean} [options.refreshable] - 是否允许刷新/重试（例如刷新 JWT）
   * @param {Object} [options.details] - 结构化内部上下文，供日志与 i18n 占位使用（默认不下发给前端）
   * @param {string} [options.message] - 用于存储原始错误信息（默认不下发给前端 用于日志）
   * @param {Object} [options.public] - 允许返回给前端的附加字段（仅该对象内的键会下发）
   */
  constructor({
    httpStatus = 500,
    messageCode = ERROR_CODES.SERVER_ERROR,
    messageType = "error",
    refreshable,
    details,
    public: publicFields,
    message,
    ...extraFields
  } = {}) {
    // super调用Error的构造函数，它只接受一个参数:message
    super(message);

    // 设置类的属性
    this.httpStatus = httpStatus; // HTTP 状态码
    this.messageCode = messageCode; // 业务逻辑的错误代码
    this.messageType = messageType; // 前端的消息类型（用于前端控制弹框的样式）
    if (refreshable !== undefined) this.refreshable = refreshable; // 是否可刷新jwt token
    if (details !== undefined) this.details = details; // 内部上下文
    if (publicFields !== undefined) this.public = publicFields; // 允许额外给前端返回的字段集合
    Object.assign(this, extraFields); // 透传其它未来可能传入的字段

    // 捕获错误调用栈，排除 constructor
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = CustomError;
