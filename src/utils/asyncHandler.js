/**
 * 包装 async 路由处理器，统一将异常交给 next(error)，避免每层 try/catch。
 * @param {Function} fn - 原始异步处理函数。
 * @returns {Function} 包装后的 Express 处理函数。
 */
function asyncHandler(fn) {
  /**
   * 执行被包装的处理函数并将异常转交给 next。
   * @param {import('express').Request} req - 请求对象。
   * @param {import('express').Response} res - 响应对象。
   * @param {import('express').NextFunction} next - 中间件传递函数。
   * @returns {void} 无返回值。
   */
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

module.exports = asyncHandler
