/*
 * @Author: zhangshouchang
 * @Date: 2025-01-05 09:23:50
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-26 22:44:29
 * @Description: File description
 */
const getI18nMessage = require("../i18n/getI18nMessage");
const { logError } = require("../utils/logger");

function errorHandler(err, req, res, next) {
  // 透传 err 中除了 stack和name的其他字段
  const { stack: _, name: __, httpStatus, messageCode, ...extraFields } = err;

  const userLanguage = req.headers["X-accept-language"] || "zh";
  const message = getI18nMessage(messageCode, userLanguage, extraFields);

  //======== 构建请求信息 用于写入错误日志 ============//
  const requestInfo = {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    body: req.body,
    query: req.query,
  };
  // 记录日志
  logError({
    message: `[${messageCode}] ${message}`,
    stack: err.stack,
    requestInfo,
  });
  //======== 构建请求信息 用于写入错误日志 ============//

  // 返回统一的错误响应
  res.status(httpStatus).json({
    status: "error",
    message,
    messageCode,
    ...extraFields,
  });
}

module.exports = errorHandler;
