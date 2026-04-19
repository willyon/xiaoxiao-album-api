const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const { validateEmail } = require('./validators')

function throwParamError({ messageType = 'error', httpStatus = 400, messageCode = ERROR_CODES.INVALID_PARAMETERS, message, details }) {
  throw new CustomError({
    httpStatus,
    messageCode,
    messageType,
    ...(message ? { message } : {}),
    ...(details !== undefined ? { details } : {})
  })
}

function parseIntOrNaN(raw) {
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? Number.NaN : n
}

/**
 * 将分页参数解析为大于等于 1 的整数；非法或小于 1 时回退 default。
 * @param {unknown} raw - query/body 中的原始值。
 * @param {number} defaultValue - 回退值（须 ≥1）。
 * @returns {number}
 */
function parsePositivePageIntOrDefault(raw, defaultValue) {
  const n = parseIntOrNaN(raw)
  if (Number.isNaN(n) || n < 1) {
    return defaultValue
  }
  return n
}

function parseIdList(ids) {
  return ids.map((id) => parseIntOrNaN(id))
}

/**
 * 统一抛出 INVALID_PARAMETERS 错误。
 * @param {{messageType?:string,httpStatus?:number,message?:string,details?:any}} [options] - 可选错误配置。
 * @returns {never} 始终抛错。
 */
function throwInvalidParametersError(options = {}) {
  throwParamError({ messageCode: ERROR_CODES.INVALID_PARAMETERS, ...options })
}

/**
 * 解析正整数路径/查询参数（>=1），否则抛 INVALID_PARAMETERS
 * @param {string | number} raw - 原始参数值。
 * @returns {number} 解析后的正整数。
 */
function parsePositiveIntParam(raw) {
  const n = parseIntOrNaN(raw)
  if (Number.isNaN(n) || n < 1) {
    throwParamError({ messageType: 'error' })
  }
  return n
}

/**
 * 校验非空 ID 数组，返回 parseInt 后的列表
 * @param {Array<string | number>} mediaIds - 待校验的 ID 列表。
 * @returns {number[]} 解析后的数字 ID 列表。
 */
function requireNonEmptyIdArray(mediaIds) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throwParamError({ messageType: 'error' })
  }
  return parseIdList(mediaIds)
}

/**
 * 从 body 读取 mediaIds，非空数组校验（回收站等可用 messageType: 'warning'）
 * @param {object} body - 请求体对象。
 * @param {{messageType?: string}} [options] - 校验异常的消息类型配置。
 * @returns {number[]} 解析后的数字 ID 列表。
 */
function requireNonEmptyMediaIds(body, { messageType = 'error' } = {}) {
  const { mediaIds } = body || {}
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throwParamError({ messageType })
  }
  return parseIdList(mediaIds)
}

/**
 * JWT 注入的 userId，缺失时抛 UNAUTHORIZED
 * @param {object} req - Express 请求对象。
 * @returns {number | string} 当前登录用户 ID。
 */
function requireUserId(req) {
  const userId = req?.user?.userId
  if (!userId) {
    throwParamError({ httpStatus: 401, messageCode: ERROR_CODES.UNAUTHORIZED, messageType: 'error' })
  }
  return userId
}

/**
 * 通用分页：query 缺省用 defaults，非法字符串回退为 defaults
 * @param {object} [query={}] - 请求查询参数。
 * @param {{pageNo:number,pageSize:number}} [defaults={ pageNo: 1, pageSize: 20 }] - 默认分页参数。
 * @returns {{pageNo:number,pageSize:number}} 分页参数。
 */
function parsePagination(query = {}, defaults = { pageNo: 1, pageSize: 20 }) {
  const pageNo = parsePositivePageIntOrDefault(query.pageNo, defaults.pageNo)
  const pageSize = parsePositivePageIntOrDefault(query.pageSize, defaults.pageSize)
  return { pageNo, pageSize }
}

/**
 * 带上下界的分页（如回收站列表：pageSize ≤ maxPageSize）
 * @param {object} query - 请求查询参数。
 * @param {{pageNo:number,pageSize:number}} [defaults={ pageNo: 1, pageSize: 20 }] - 默认分页参数。
 * @param {{maxPageSize?: number}} [options] - 分页限制配置。
 * @returns {{pageNo:number,pageSize:number}} 通过校验的分页参数。
 */
function parseBoundedPagination(query, defaults = { pageNo: 1, pageSize: 20 }, { maxPageSize = 100 } = {}) {
  const pageNo = parsePositivePageIntOrDefault(query?.pageNo, defaults.pageNo)
  const pageSize = parsePositivePageIntOrDefault(query?.pageSize, defaults.pageSize)
  if (pageSize > maxPageSize) {
    throwParamError({ messageType: 'warning' })
  }
  return { pageNo, pageSize }
}

/**
 * 从请求体提取邮箱并进行非空校验。
 * @param {object} body - 请求体对象。
 * @returns {string} 邮箱字符串。
 */
function requireEmail(body) {
  const { email } = body || {}
  validateEmail(email)
  return email
}

/**
 * 从请求体提取邮箱和密码并进行非空校验。
 * @param {object} body - 请求体对象。
 * @returns {{email: string, password: string}} 邮箱与密码对象。
 */
function requireEmailAndPassword(body) {
  const { email, password } = body || {}
  validateEmail(email)
  if (!password) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.PASSWORD_REQUIRED,
      messageType: 'warning'
    })
  }
  return { email, password }
}

module.exports = {
  throwInvalidParametersError,
  parsePositiveIntParam,
  requireNonEmptyIdArray,
  requireNonEmptyMediaIds,
  requireUserId,
  parsePagination,
  parseBoundedPagination,
  requireEmail,
  requireEmailAndPassword
}
