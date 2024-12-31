/*
 * @Author: zhangshouchang
 * @Date: 2024-12-11 21:09:07
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-28 09:26:10
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// 登录或注册
router.post("/loginOrRegister", authController.handleLoginOrRegister);

// 验证邮箱的接口
router.get("/verifyEmail", authController.handleVerifyEmail);

// 登出
router.post("/logout", authController.handleLogout);

// 重发验证邮件的接口
router.post("/resendVerificationEmail", authController.handleResendVerificationEmail);

module.exports = router;
