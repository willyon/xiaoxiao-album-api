/**
 * Graceful shutdown initializer
 *
 * 统一在一个地方注册进程信号（SIGINT/SIGTERM/beforeExit），
 * 并按顺序优雅关闭：
 *   1) 停止接收新的 HTTP 连接（server.close）
 *   2) 关闭外部依赖（Redis/DB/消息队列等）
 *   3) 尽量刷写日志（logger 由自身的 signal 处理或这里手动调用可选回调）
 *   4) 在超时兜底下退出
 *
 * 用法（在 server.js 中）：
 *   const initGracefulShutdown = require('./src/utils/gracefulShutdown');
 *   const server = app.listen(PORT, ...);
 *   initGracefulShutdown({
 *     server,
 *     getRedisClient,              // 函数：返回已复用的 Redis 客户端实例（若没有可不传）
 *     extraClosers: [              // 可选：额外清理动作（返回 Promise 或同步）
 *       async () => prisma?.$disconnect?.(),
 *       async () => someQueue?.close?.()
 *     ],
 *     timeoutMs: 10000            // 可选：优雅退出的最长等待时长（毫秒）
 *   });
 */

const logger = require('./logger')
const SHUTDOWN_STATE_KEY = '__XX_GRACEFUL_SHUTDOWN_STATE__'

/**
 * 初始化进程优雅退出处理器。
 * @param {{server?:{close?:(cb:Function)=>void},getRedisClient?:Function,extraClosers?:Array<Function>,timeoutMs?:number}} [options={}] - 优雅退出配置。
 * @returns {void} 无返回值。
 */
module.exports = function initGracefulShutdown({ server, getRedisClient, extraClosers = [], timeoutMs = 10000 } = {}) {
  if (!globalThis[SHUTDOWN_STATE_KEY]) {
    globalThis[SHUTDOWN_STATE_KEY] = {
      initialized: false,
      shuttingDown: false,
      server: null,
      getRedisClient: null,
      extraClosers: new Set(),
      timeoutMs
    }
  }
  const state = globalThis[SHUTDOWN_STATE_KEY]
  if (server) state.server = server
  if (typeof getRedisClient === 'function') state.getRedisClient = getRedisClient
  if (Array.isArray(extraClosers)) {
    for (const closer of extraClosers) {
      if (typeof closer === 'function') state.extraClosers.add(closer)
    }
  }
  state.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : state.timeoutMs

  /**
   * 执行一次完整的优雅退出流程。
   * @param {string} signal - 触发退出的信号名。
   * @returns {Promise<void>} 无返回值。
   */
  async function shutdown(signal) {
    if (state.shuttingDown) return
    state.shuttingDown = true

    const start = Date.now()
    const tag = `[graceful-shutdown:${signal}]`

    // 超时兜底：到时强制退出，避免卡死。在node环境中settimeout()的返回对象会有一个unref的方法，
    // 用于将这个定时器从事件循环里“摘掉引用”，这样如果进程里只剩下这个定时器在等，进程可以直接退出，
    // 不必为了等这个定时器而“被挂住”
    const forceTimer = setTimeout(() => {
      try {
        logger.error({
          message: `${tag} force exit after timeout ${state.timeoutMs}ms`,
          details: { elapsed: Date.now() - start } //真实的超时时长
        })
      } catch {}
      process.exit(1) //0表示正常退出 1表示一般性错误，异常退出
    }, state.timeoutMs).unref?.()

    try {
      // 1) 停止接收新的 HTTP 连接
      if (state.server && typeof state.server.close === 'function') {
        await new Promise((resolve) => {
          try {
            state.server.close(() => resolve())
          } catch {
            resolve()
          }
        })
      }

      // 2) 关闭 Redis（如果提供了 getRedisClient）
      if (typeof state.getRedisClient === 'function') {
        try {
          const redis = state.getRedisClient()
          if (redis && typeof redis.quit === 'function') {
            await redis.quit()
          } else if (redis && typeof redis.disconnect === 'function') {
            await redis.disconnect()
          }
        } catch (e) {
          logger.warn({ message: `${tag} redis close failed`, details: { error: String(e) } })
        }
      }

      // 3) 执行额外的清理动作（可选）
      for (const closer of state.extraClosers) {
        try {
          const ret = closer?.()
          if (ret && typeof ret.then === 'function') await ret
        } catch (e) {
          logger.warn({ message: `${tag} extra closer failed`, details: { error: String(e) } })
        }
      }

      // 4) 记录完成与耗时
      try {
        logger.info({ message: `${tag} completed`, details: { elapsed: Date.now() - start } })
      } catch {}

      //关闭日志写入(关闭前会将尚未处理的日志写进日志文件中)
      try {
        await logger.close()
      } catch {}
      // 正常退出
      process.exit(0)
    } catch (e) {
      try {
        logger.error({ message: `${tag} failed`, details: { error: String(e) } })
      } catch {}
      try {
        await logger.close()
      } catch {}
      // 异常退出
      process.exit(1)
    } finally {
      clearTimeout(forceTimer)
    }
  }

  if (state.initialized) return
  state.initialized = true

  ;['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => shutdown(sig))
  })

  //node应用事件 beforeExit事件：事件循环将空时触发，非 SIGINT/SIGTERM 触发的自然退出兜底,
  // 可做最后一次清理（前提是在shutdown里没有主动process.exit()，否则不会进入这个事件里）
  process.on('beforeExit', () => {
    try {
      logger.info({ message: '[graceful-shutdown:beforeExit] flushing final tasks' })
    } catch {}
    try {
      logger.close().catch(() => {})
    } catch {}
  })
}
