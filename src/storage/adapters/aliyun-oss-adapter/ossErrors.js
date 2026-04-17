/*
 * @Description: OSS 操作统一错误日志与抛出
 */

function handleOssError(logger, error, operation, context = {}) {
  logger.error({
    message: `AliyunOSS ${operation} failed`,
    details: {
      code: error.code,
      message: error.message,
      status: error.status,
      requestId: error.requestId,
      ...context
    }
  })
  throw error
}

module.exports = { handleOssError }
