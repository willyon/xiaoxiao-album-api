/*
 * @Author: zhangshouchang
 * @Date: 2024-12-11 21:09:07
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-14 01:05:42
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// 登录或注册
router.post("/loginOrRegister", authController.loginOrRegister);

// 验证邮箱的接口
router.get("/verifyEmail", authController.verifyEmail);

// 登出
router.post("/logout", authController.logout);

// 重发验证邮件的接口
router.post("/resendVerificationEmail", authController.resendVerificationEmail);

module.exports = router;
