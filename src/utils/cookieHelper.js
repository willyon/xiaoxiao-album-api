/*
 * @Author: zhangshouchang
 * @Date: 2025-01-08 14:12:48
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-25 12:29:34
 * @Description: File description
 */
/**
 * 设置响应 Cookie，并合并默认安全选项。
 * @param {import('express').Response} res - Express 响应对象。
 * @param {string} name - Cookie 名称。
 * @param {string} value - Cookie 值。
 * @param {object} [options={}] - 自定义 Cookie 选项。
 * @returns {void} 无返回值。
 */
function setCookie(res, name, value, options = {}) {
  const defaultOptions = {
    httpOnly: true,
    // secure: process.env.NODE_ENV === "production", // 在生产环境启用 Secure 只有在https下才发送该cookie
    sameSite: 'Strict', // 只有在同站点请求时才带上该cookie 防止 CSRF
    // maxAge: 7 * 24 * 60 * 60 * 1000, // cookie有效期 7天
    maxAge: parseInt(process.env.JWT_REFRESH_EXPIRES_IN_MS)
  }

  // 合并默认选项和自定义选项
  const cookieOptions = { ...defaultOptions, ...options }

  // 设置 Cookie
  res.cookie(name, value, cookieOptions)
}

module.exports = { setCookie }
