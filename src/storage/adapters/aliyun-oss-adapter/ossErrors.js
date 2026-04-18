/*
 * @Description: OSS 操作统一错误日志与抛出
 */

/**
 * 统一处理 OSS 错误：记录日志并重新抛出。
 * @param {{error:(payload:object)=>void}} logger - 日志对象。
 * @param {Error & {code?:string,status?:number,requestId?:string}} error - OSS 错误。
 * @param {string} operation - 操作名称。
 * @param {object} [context={}] - 附加上下文。
 * @returns {never} 总是抛出异常。
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
