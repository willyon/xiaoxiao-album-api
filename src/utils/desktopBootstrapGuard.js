/*
 * @Description: 桌面静默登录（desktop-bootstrap）请求闸门：仅本机回环 + DESKTOP_LOCAL_MODE=true
 */

/**
 * 是否开启桌面本地模式（仅认小写 true，避免 1/true 多种写法）
 * @returns {boolean}
 */
function isTruthyDesktopLocalMode() {
  return String(process.env.DESKTOP_LOCAL_MODE ?? '').trim().toLowerCase() === 'true'
}

/**
 * 常见本机回环形式（不含 127.0.0.2 等少见地址）。
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isLoopbackRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/**
 * 是否允许调用 desktop-bootstrap：本机回环 + `DESKTOP_LOCAL_MODE=true`
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isDesktopBootstrapAllowed(req) {
  if (!isLoopbackRequest(req)) return false
  return isTruthyDesktopLocalMode()
}

module.exports = {
  isDesktopBootstrapAllowed
}
