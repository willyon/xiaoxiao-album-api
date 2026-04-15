/*
 * @Author: zhangshouchang
 * @Date: 2025-02-15 17:16:40
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-28 14:15:14
 * @Description: File description
 */
const express = require('express')
const router = express.Router()
const authMiddleware = require('../middlewares/authMiddleware')
const {
  handleLoginOrRegister,
  handleLogoutUser,
  handleRefreshToken,
  handleCheckLoginStatus,
  handleResendVerificationEmail,
  handleVerifyEmail,
  handleRequestPasswordReset,
  handleConfirmPasswordReset
} = require('../controllers/authController')

// 创建会话（登录/注册统一接口）
router.post('/session', handleLoginOrRegister)
// 获取当前登录用户信息（需要鉴权）
router.get('/me', authMiddleware, handleCheckLoginStatus)
// 删除会话（登出）
router.delete('/session', authMiddleware, handleLogoutUser)
// 重发验证邮件的接口
router.post('/verify-email/resend', handleResendVerificationEmail)
// 验证邮箱的接口
router.get('/verify-email', handleVerifyEmail)
// 请求发送重置密码邮件
router.post('/password-reset/request', handleRequestPasswordReset)
// 提交新密码完成重置
router.post('/password-reset/confirm', handleConfirmPasswordReset)
//通过refresh token 更新 jwt token
router.post('/refreshToken', handleRefreshToken)

module.exports = router
