/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:31:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-17 22:37:33
 * @Description: File description
 */
const authService = require("../services/authService");
// const CustomError = require("../errors/customError");
const handleErrorResponse = require("../errors/errorResponseHandler");

const loginOrRegister = async (req, res) => {
  const { email, password } = req.body;

  if (!email) {
    return res.status(400).json({ messageCode: "EMAIL_REQUIRED", message: "Email is required", messageType: "warning" });
  }
  if (!password) {
    return res.status(400).json({ messageCode: "PASSWORD_REQUIRED", message: "Password is required", messageType: "warning" });
  }

  try {
    // 查询用户是否存在
    const existingUser = await authService.findUserByEmail(email);

    if (!existingUser) {
      // 如果用户不存在，创建新账户
      const newUser = await authService.createNewUser(email, password);
      await authService.sendVerificationEmail(email, newUser.verificationJWTToken);

      return res.status(201).json({
        messageCode: "ACCOUNT_PENDING_ACTIVATION",
        message: "Account created successfully, please check your email to activate your account",
        data: newUser,
        messageType: "success",
      });
    }

    // 账户存在，处理账户状态
    const { verifiedStatus, password: hashedPassword } = existingUser;

    if (verifiedStatus === "deactivated") {
      // 账户已被禁用
      return res.status(403).json({ messageCode: "ACCOUNT_INACTIVE", message: "Account is deactivated", messageType: "error" });
    }

    // 统一的密码验证逻辑
    const isPasswordValid = await authService.validatePassword(password, hashedPassword);
    if (!isPasswordValid) {
      return res.status(400).json({ messageCode: "INVALID_PASSWORD", message: "Invalid email or password", messageType: "warning" });
    }

    if (verifiedStatus === "pending") {
      // 账户未激活，重发激活邮件
      await resendEmailHandler(res, email);
    } else if (verifiedStatus === "active") {
      // 账户已激活，登录成功
      const token = authService.generateJWTToken(existingUser.id);
      return res.status(200).json({
        messageCode: "LOGIN_SUCCESS",
        message: "Login successful",
        data: { token, user: existingUser },
        messageType: "success",
      });
    }
  } catch (error) {
    handleErrorResponse(res, error);
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    // 调用authService的verifyEmail方法进行Token验证
    await authService.verifyEmail(token);
    res.status(200).json({ messageCode: "ACCOUNT_VERIFIED_SUCCESS", message: "account verification success", messageType: "success" });
  } catch (error) {
    handleErrorResponse(res, error);
  }
};

const logout = async (req, res) => {
  try {
    await authService.logout(req);
    res.status(200).json({ messageCode: "LOGOUT_SUCCESS", message: "Logout success", messageType: "success" });
  } catch (error) {
    handleErrorResponse(res, error);
  }
};

// 重发验证邮件的接口
const resendVerificationEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ messageCode: "EMAIL_REQUIRED", message: "email is empty", messageType: "warning" });
    }

    await resendEmailHandler(res, email);
  } catch (error) {
    handleErrorResponse(res, error);
  }
};

const resendEmailHandler = async (res, email) => {
  // 检查是否在短时间内多次请求
  try {
    const isCooldown = await authService.checkCooldown(email);
    if (isCooldown) {
      return res.status(429).json({ messageCode: "REQUESTS_TOO_FREQUENT", message: "frequent requests", messageType: "warning" });
    }

    // 重新发送激活邮件
    const result = await authService.resendVerificationEmail(email);
    res
      .status(200)
      .json({ messageCode: "EMAIL_VERIFICATION_RESENT", message: "resend verification email success", messageType: "success", data: result });
  } catch (error) {
    handleErrorResponse(res, error);
  }
};

module.exports = {
  loginOrRegister,
  verifyEmail,
  logout,
  resendVerificationEmail,
};
