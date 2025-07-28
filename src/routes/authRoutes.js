/*
 * @Author: zhangshouchang
 * @Date: 2025-02-15 17:16:40
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-28 14:15:14
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const {
  handleLoginOrRegister,
  handleLogoutUser,
  handleRefreshToken,
  handleCheckLoginStatus,
  handleResendVerificationEmail,
  handleVerifyEmail,
} = require("../controllers/authController");

// 注册/登录
router.post("/loginOrRegister", handleLoginOrRegister);
// 重发验证邮件的接口
router.post("/resendVerificationEmail", handleResendVerificationEmail);
// 验证邮箱的接口
router.get("/verifyEmail", handleVerifyEmail);
//通过refresh token 更新 jwt token
router.post("/refreshToken", handleRefreshToken);
// 登出
router.post("/logoutUser", handleLogoutUser);

// 判断当前页面是否已有登录用户（需要鉴权）
router.get("/checkLoginStatus", authMiddleware, handleCheckLoginStatus);

module.exports = router;
