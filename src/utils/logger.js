/*
 * @Author: zhangshouchang
 * @Date: 2025-01-06 15:27:15
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-19 01:02:40
 * @Description: File description
 */
const fs = require('fs')
const path = require('path')
const { DateTime } = require('luxon')

// 从 .env 文件中读取日志目录路径
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs')

// 确保日志目录存在 没有则新建
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

// 固定单文件日志路径（不再按天切分）
const LOG_FILE_NAME = process.env.LOG_FILE_NAME || 'current.log'
const LOG_FILE_PATH = path.join(LOG_DIR, LOG_FILE_NAME)

/**
 * 安全地将任意值转换为字符串，防止日志内容过长或序列化异常导致内存问题。
 * - bigint 类型不能直接 JSON.stringify，会抛异常，所以需要特殊处理转为字符串（如数据库自增ID等场景）。
 * - function、symbol、undefined 等类型如果直接作为对象属性 JSON.stringify，会被忽略（键值对消失），
 *   但如果直接传入 JSON.stringify(undefined) 会返回 undefined（不是字符串），需要兜底。
 * - 如果序列化失败（如循环引用对象），最终兜底返回 "[unstringifiable]"，保证日志系统健壮性。
 * @param {*} v 任意待序列化的值
 * @param {number} max 截断最大长度
 * @returns {string}
 */
function toSafeString(v, max = 4000) {
  if (v == null) return '' // null或undefined时返回空字符串
  try {
    if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…[truncated]' : v // 若是字符串且超长则截断
    // bigint 不能直接 JSON.stringify，否则会抛错，需转字符串
    let s = JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))
    // 兜底：s 可能为 undefined（如直接传 undefined、function、symbol），此时 JSON.stringify 返回 undefined
    if (typeof s !== 'string') s = String(v)
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s // 判断序列化结果是否超长
  } catch {
    try {
      // 兜底：如循环引用对象等无法序列化，直接 String
      return String(v)
    } catch {
      // 最终兜底，任何异常都不影响主流程
      return '[unstringifiable]'
    }
  }
}

/**
 * 日志脱敏函数，防止敏感信息如 token、cookie、api key 等泄漏到日志中。
 * 典型用例：记录 requestInfo 时将 headers 中的敏感字段替换为 "[redacted]"。
 * @param {Object} obj
 * @returns {Object} 脱敏后的副本
 */
function redact(obj = {}) {
  try {
    const clone = { ...obj }
    if (clone.headers && typeof clone.headers === 'object') {
      const h = { ...clone.headers }
      // 明确脱敏常见的敏感头部
      ;['authorization', 'cookie', 'set-cookie', 'x-api-key'].forEach((k) => {
        if (h[k] != null) h[k] = '[redacted]'
      })
      clone.headers = h
    }
    if (clone.body && typeof clone.body === 'object') {
      const h = { ...clone.body }
      // 明确脱敏常见的敏感头部
      ;['password'].forEach((k) => {
        if (h[k] != null) h[k] = '[redacted]'
      })
      clone.body = h
    }
    return clone
  } catch {
    // 脱敏失败时直接返回原对象，保证日志流程不中断
    return obj
  }
}

// 创建日志流（固定单文件）
let logStream = null
// 背压标志：日志写入流的缓冲区满时进入背压状态，后续日志写入队列等待
let backpressured = false
// 日志消息队列：用于缓存因背压未能及时写入的日志
let queue = []
// 队列最大长度，防止内存暴涨。到达上限时丢弃最旧的日志（先进先出）
const MAX_QUEUE = 5000
// 统计因队列溢出被丢弃的日志条数，方便监控日志可靠性
let droppedCount = 0
let currentLogDate = null
/**
 * 获取固定日志文件写入流。
 * 首次初始化时先清空旧日志，确保文件仅保留当前进程周期日志。
 */
function getLogStream() {
  const today = DateTime.now().toFormat('yyyy-MM-dd')
  const dateChanged = currentLogDate !== today
  if (!logStream || logStream.path !== LOG_FILE_PATH || dateChanged) {
    if (logStream) {
      try {
        logStream.end()
      } catch {}
    }
    if (dateChanged) {
      // 跨天时清空固定日志文件，仅保留当天日志
      try {
        fs.writeFileSync(LOG_FILE_PATH, '')
      } catch {}
    }
    currentLogDate = today
    logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' }) // 固定文件追加写入
    logStream.on('error', (err) => {
      // 写入流出错只做控制台告警，避免影响主流程
      console.error('Log stream error:', err)
    })
  }
  return logStream
}

// 格式化日志信息（首行携带 code / requestId）
function formatLogMessage({ timestamp, level, code, requestId, message, details, userMessage, stack, requestInfo }) {
  return [
    `[${timestamp}] [${level.toUpperCase()}]${code ? ' [' + code + ']' : ''}${requestId ? ' [rid:' + requestId + ']' : ''} ${message}`,
    details ? `Details: ${toSafeString(details)}` : null, // 结构化上下文
    userMessage ? `User Message: ${userMessage}` : null, // 返回给用户的i18n文案（便于对照）
    requestInfo ? `Request Info: ${toSafeString(redact(requestInfo))}` : null, // 脱敏后写入
    stack ? `Stack Trace: ${stack}` : null,
    '\n'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 写入日志（队列+背压控制，防止高并发下丢日志/内存暴涨）
 * - 若写入流缓冲区满（backpressured），日志进入队列等待
 * - 队列超长时丢弃最旧日志并计数（droppedCount）
 * - 只有当缓冲区 drain 事件触发时才 flush 队列，避免递归写爆内存
 */
function logToFile(logMessage) {
  try {
    const stream = getLogStream()

    // 若此前处于背压状态或已有待写队列，则入队等待 flush
    if (backpressured || queue.length > 0) {
      if (queue.length >= MAX_QUEUE) {
        queue.shift()
        droppedCount++
      }
      queue.push(logMessage)
      return
    }

    // 直接尝试写入
    const ok = stream.write(logMessage + '\n')
    if (!ok) {
      // 写入已被接受到内部缓冲，但触发了背压；交给 flushQueue 自行监听 drain 并写到底
      backpressured = true
      try {
        flushQueue()
      } catch {}
    }
  } catch (e) {
    // 日志系统自身异常时，保证不影响主流程
    console.error('Failed to write log:', e)
  }
}

/**
 * 尝试将队列中的日志刷入文件。
 * - 只在 drain 事件中触发（stream.once），避免多次并发写入导致递归爆栈。
 * - 如果写入流再次被背压，则再次等待 drain。
 * - 若期间有日志被丢弃（droppedCount > 0），写一条告警日志。
 */
function flushQueue() {
  return new Promise((resolve) => {
    try {
      const stream = getLogStream()

      const step = () => {
        try {
          backpressured = false

          // 若期间有被丢弃的日志，先写一条告警（这条也可能触发背压）
          if (droppedCount > 0) {
            const warn = `[${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')}] [WARN] Logger queue dropped ${droppedCount} messages due to backpressure`
            droppedCount = 0
            const okWarn = stream.write(warn + '\n')
            if (!okWarn) {
              backpressured = true
              return stream.once('drain', step)
            }
          }

          while (queue.length > 0) {
            const next = queue.shift()
            const ok = stream.write(next + '\n')
            if (!ok) {
              backpressured = true
              return stream.once('drain', step)
            }
          }

          // 队列已清空且没有背压，完成
          return resolve()
        } catch (e) {
          console.error('Failed to flush log queue:', e)
          return resolve()
        }
      }

      step()
    } catch (e) {
      console.error('Failed to flush log queue (init):', e)
      return resolve()
    }
  })
}

/**
 * 供优雅退出流程调用：尽量把队列刷盘，并关闭写流
 */
function closeLogger(timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const stream = logStream
      if (!stream) return resolve()

      // 超时兜底：到时强制退出，避免卡死。在node环境中settimeout()的返回对象会有一个unref的方法，
      // 用于将这个定时器从事件循环里“摘掉引用”，这样如果进程里只剩下这个定时器在等，进程可以直接退出，
      // 不必为了等这个定时器而“被挂住”
      const timer = setTimeout(() => {
        console.warn(`Logger close timed out after ${timeoutMs}ms`)
        resolve()
      }, timeoutMs)
      timer.unref?.()

      flushQueue().finally(() => {
        try {
          stream.once('finish', () => {
            clearTimeout(timer)
            resolve()
          })
          stream.once('error', () => {
            clearTimeout(timer)
            resolve()
          })
          stream.end()
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    } catch {
      resolve()
    }
  })
}

/**
 * logger 对象，包含 error/info/warn/close 方法
 */
const logger = {
  /**
   * 错误日志
   * @param {Object} param0
   */
  error({ message, code, requestId, details, messageToUserI18n, stack, requestInfo }) {
    const timestamp = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')
    const logMessage = formatLogMessage({
      timestamp,
      level: 'error',
      message: toSafeString(message),
      code,
      requestId,
      details,
      userMessage: toSafeString(messageToUserI18n),
      stack,
      requestInfo
    })
    logToFile(logMessage)
    console.error(logMessage)
  },
  /**
   * 警告日志
   * @param {Object} param0
   */
  warn({ message, code, requestId, details }) {
    const timestamp = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')
    const logMessage = formatLogMessage({
      timestamp,
      level: 'warn',
      message: toSafeString(message),
      code,
      requestId,
      details
    })
    logToFile(logMessage)
    console.warn(logMessage)
  },
  /**
   * 信息日志
   * @param {Object} param0
   */
  info({ message, code, requestId, details }) {
    const timestamp = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')
    const logMessage = formatLogMessage({
      timestamp,
      level: 'info',
      message: toSafeString(message),
      code,
      requestId,
      details
    })
    logToFile(logMessage)
    console.log(logMessage)
  },

  /**
   * 关闭日志流
   */
  close: closeLogger
}

module.exports = logger
