/**
 * 统一格式化错误响应
 * @param {Object} res - Express 的 res 对象
 * @param {Object} error - 捕获的错误对象，通常是 CustomError 或普通的 Error
 */
const handleErrorResponse = (res, error = {}) => {
  // 1. 提取错误的字段和默认值
  const { httpStatus = 500, messageCode = "SERVER_ERROR", message = "An error occurred", messageType = "error" } = error;

  // 2. 创建一个干净的响应数据（不包含 httpStatus）
  const response = {
    messageCode: typeof messageCode === "string" ? messageCode : "SERVER_ERROR",
    message: typeof message === "string" ? message : "An error occurred",
    messageType: typeof messageType === "string" ? messageType : "error",
  };

  // 3. 记录错误日志（便于调试）
  //   console.error(`[ERROR] httpStatus: ${httpStatus}, messageCode: ${messageCode}, message: ${message}`);

  // 4. 返回响应数据
  res.status(httpStatus).json(response);
};

module.exports = handleErrorResponse;
