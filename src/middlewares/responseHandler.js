/*
 * @Author: zhangshouchang
 * @Date: 2025-01-01 18:00:02
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-26 22:51:11
 * @Description: File description
 */
const { setCookie } = require("../utils/cookieHelper");
// 优化成自动导入 这样后面加文件就不需要手动添加了
const getI18nMessage = require("../i18n/getI18nMessage");
const { SUCCESS_CODES } = require("../constants/messageCodes");

// 修改为导出中间件函数
const responseHandler = (req, res, next) => {
  req.userLanguage = req.headers["X-accept-language"] || "zh"; // 根据请求头选择语言

  res.sendResponse = ({ messageCode = SUCCESS_CODES.REQUEST_COMPLETED, data = null, httpStatus = 200, ...extraFields } = {}) => {
    const message = getI18nMessage(messageCode, req.userLanguage, extraFields);

    res.status(httpStatus).json({
      messageCode,
      status: "success",
      messageType: "success",
      message,
      data,
    });
  };

  res.setCookie = (name, value, options) => setCookie(res, name, value, options);

  next();
};

// 导出两个函数
module.exports = {
  responseHandler,
};
