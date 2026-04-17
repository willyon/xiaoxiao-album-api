/**
 * 包装 async 路由处理器，统一将异常交给 next(error)，避免每层 try/catch。
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

module.exports = asyncHandler
