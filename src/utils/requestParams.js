const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')

/**
 * 解析正整数路径/查询参数（>=1），否则抛 INVALID_PARAMETERS
 */
function parsePositiveIntParam(raw) {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }
  return n
}

/**
 * 校验非空 ID 数组，返回 parseInt 后的列表
 */
function requireNonEmptyIdArray(mediaIds) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'error'
    })
  }
  return mediaIds.map((id) => parseInt(id, 10))
}

/**
 * 从 body 读取 mediaIds，非空数组校验（回收站等可用 messageType: 'warning'）
 */
function requireNonEmptyMediaIds(body, { messageType = 'error' } = {}) {
  const { mediaIds } = body || {}
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType
    })
  }
  return mediaIds.map((id) => parseInt(id, 10))
}

/**
 * JWT 注入的 userId，缺失时抛 UNAUTHORIZED
 */
function requireUserId(req) {
  const userId = req?.user?.userId
  if (!userId) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: 'error'
    })
  }
  return userId
}

/**
 * 通用分页：query 缺省用 defaults，非法字符串回退为 defaults
 */
function parsePagination(query = {}, defaults = { pageNo: 1, pageSize: 20 }) {
  const pageNo = parseInt(query.pageNo ?? defaults.pageNo, 10) || defaults.pageNo
  const pageSize = parseInt(query.pageSize ?? defaults.pageSize, 10) || defaults.pageSize
  return { pageNo, pageSize }
}

/**
 * 带上下界的分页（如回收站列表：pageSize ≤ maxPageSize）
 */
function parseBoundedPagination(query, defaults = { pageNo: 1, pageSize: 20 }, { maxPageSize = 100 } = {}) {
  const pageNo = Number(query.pageNo) || defaults.pageNo
  const pageSize = Number(query.pageSize) || defaults.pageSize
  if (pageNo < 1 || pageSize < 1 || pageSize > maxPageSize) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }
  return { pageNo, pageSize }
}

function requireEmail(body) {
  const { email } = body || {}
  if (!email) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.EMAIL_REQUIRED,
      messageType: 'warning'
    })
  }
  return email
}

function requireEmailAndPassword(body) {
  const { email, password } = body || {}
  if (!email || !password) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: !email ? ERROR_CODES.EMAIL_REQUIRED : ERROR_CODES.PASSWORD_REQUIRED,
      messageType: 'warning'
    })
  }
  return { email, password }
}

module.exports = {
  parsePositiveIntParam,
  requireNonEmptyIdArray,
  requireNonEmptyMediaIds,
  requireUserId,
  parsePagination,
  parseBoundedPagination,
  requireEmail,
  requireEmailAndPassword
}
