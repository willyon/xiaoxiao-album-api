/*
 * @Author: zhangshouchang
 * @Date: 2024-12-13 16:31:24
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-28 15:40:53
 * @Description: File description
 */
// 将这个文件的参数校验的逻辑挪到service中去 待整理
const jwt = require("jsonwebtoken");
const authService = require("../services/authService");
const CustomError = require("../errors/customError");
const { getRedisClient } = require("../services/redisClient");
const CooldownManager = require("../services/cooldownService");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");

// 用户注册/登录
const handleLoginOrRegister = async (req, res, next) => {
  const { email, password } = req.body;

  // 邮箱和密码参数不能为空
  if (!email || !password) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: !email ? ERROR_CODES.EMAIL_REQUIRED : ERROR_CODES.PASSWORD_REQUIRED,
      messageType: "warning",
    });
  }

  try {
    // 查询用户是否存在
    let existingUser = await authService.getUserInfoByEmail(email);
    console.log("Existing user:", existingUser); // 添加日志

    // 用户不存在，执行注册流程
    if (!existingUser) {
      console.log("Creating new user..."); // 添加日志
      const newUser = await authService.createNewUser({ email, password });
      console.log("New user created:", newUser); // 添加日志

      await authService.sendVerificationEmail({
        email,
        JWTToken: newUser.verificationJWTToken,
        language: req.userLanguage,
      });

      // 提示用户去邮箱激活账号
      return res.sendResponse({
        messageCode: SUCCESS_CODES.ACCOUNT_PENDING_ACTIVATION,
        data: newUser,
        httpStatus: 201,
      });
    }

    // 用户存在，验证密码
    const isPasswordValid = await authService.validateInputPassword(password, existingUser.password);
    if (!isPasswordValid) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PASSWORD,
        messageType: "error",
      });
    }

    // 密码正确，检查账户状态
    const { verifiedStatus } = existingUser;

    if (verifiedStatus === "deactivated") {
      throw new CustomError({
        httpStatus: 403,
        messageCode: ERROR_CODES.ACCOUNT_INACTIVE,
        messageType: "error",
      });
    }

    if (verifiedStatus === "pending") {
      // 账户未激活，重发激活邮件
      await resendEmailHandler({ email, req, res });
    } else if (verifiedStatus === "active") {
      try {
        // 账户已激活，登录成功
        const jwtToken = authService.generateJWTToken(existingUser.id);
        // 生成refresh token
        const refreshToken = await authService.generateAndStoreRefreshToken(existingUser.id);
        // 将 refreshToken 写入 Cookie(httpOnly)
        res.setCookie("refresh_token", refreshToken);

        // 返回登录成功数据
        return res.sendResponse({
          messageCode: SUCCESS_CODES.LOGIN_SUCCESS,
          data: {
            jwtToken, // JWT token 用于 Authorization 头
            user: {
              id: existingUser.id,
              email: existingUser.email,
            },
          },
        });
      } catch (error) {
        console.error("Login error:", error);
        throw new CustomError({
          httpStatus: 500,
          messageCode: ERROR_CODES.SERVER_ERROR,
          messageType: "error",
        });
      }
    }
  } catch (error) {
    console.error("Login/Register error:", error); // 添加错误日志
    next(error);
  }
};

// 用户登出
const handleLogoutUser = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (!refreshToken) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
        refreshable: false,
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      res.clearCookie("refresh_token");
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.INVALID_REFRESH_TOKEN,
        messageType: "error",
        refreshable: false,
      });
    }

    // 解码 refresh token 获取 userId
    try {
      const redisClient = await getRedisClient();
      const redisKey = `refresh_token_${decoded.userId}`;
      await redisClient.del(redisKey); // 删除 Redis 中的 token
    } catch (redisErr) {
      // 记录日志，但不阻止继续清除 cookie 和返回成功
      console.error("Redis 清除 refresh token 失败", redisErr);
    }
    res.clearCookie("refresh_token"); // 清除浏览器 cookie
    res.sendResponse({
      messageCode: SUCCESS_CODES.LOGOUT_SUCCESS,
    });
  } catch (err) {
    next(err);
  }
};

const handleVerifyEmail = async (req, res, next) => {
  try {
    const { token } = req.query;
    // 调用authService的verifyEmail方法进行Token验证
    await authService.verifyEmail(token);
    res.sendResponse({ messageCode: SUCCESS_CODES.ACCOUNT_VERIFIED_SUCCESS });
  } catch (error) {
    next(error);
  }
};

// 判断用户登录状态
const handleCheckLoginStatus = async (req, res, next) => {
  try {
    const userId = req.user.userId; // 由 authMiddleware 解码并注入的 userId

    const existingUser = await authService.getUserInfoById(userId);
    if (!existingUser || existingUser.verifiedStatus !== "active") {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
        refreshable: false,
      });
    }

    // 登录状态有效
    return res.sendResponse({
      messageCode: SUCCESS_CODES.LOGIN_SUCCESS,
      // data: {
      //   user: {
      //     id: existingUser.id,
      //     email: existingUser.email,
      //   },
      // },
    });
  } catch (error) {
    next(error);
  }
};

// 重发验证邮件的接口
const handleResendVerificationEmail = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.EMAIL_REQUIRED,
        messageType: "warning",
      });
    }

    await resendEmailHandler({ req, res, email });
  } catch (error) {
    next(error);
  }
};

const resendEmailHandler = async ({ req, res, email }) => {
  try {
    // 检查是否在短时间内多次请求
    const redisClient = await getRedisClient();
    const cooldownManager = new CooldownManager(redisClient, { defaultCooldown: parseInt(process.env.EMAIL_COOLDOWN_SECONDS) });
    const isCooling = await cooldownManager.isCoolingDown("email", email);
    if (isCooling) {
      const remaining = await cooldownManager.getRemainingCooldown("email", email);
      throw new CustomError({
        httpStatus: 429,
        messageCode: ERROR_CODES.REQUESTS_TOO_FREQUENT,
        messageType: "warning",
        retryAfterSeconds: remaining,
      });
    }

    // 重新发送激活邮件
    const result = await authService.resendVerificationEmail({ email, req });
    // 设置冷却时间
    cooldownManager.setCooldown("email", email);
    res.sendResponse({ messageCode: SUCCESS_CODES.EMAIL_VERIFICATION_RESENT, data: result });
  } catch (error) {
    throw error;
  }
};

// 通过refresh token(先与redis中存储的refresh token校验)更新jwt token
const handleRefreshToken = async (req, res, next) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    throw new CustomError({
      httpStatus: 401,
      messageCode: ERROR_CODES.UNAUTHORIZED,
      messageType: "error",
      refreshable: false,
    });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const userId = decoded.userId;

    // 从 Redis 获取存储的 refresh token
    const redisClient = await getRedisClient();
    const redisKey = `refresh_token_${userId}`;
    const storedToken = await redisClient.get(redisKey);

    if (!storedToken || storedToken !== refreshToken) {
      throw new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.INVALID_REFRESH_TOKEN,
        messageType: "error",
        refreshable: false,
      });
    }

    // 更新 jwtToken
    const newJwtToken = authService.generateJWTToken(userId);
    // 更换 refresh token
    const newRefreshToken = await authService.generateAndStoreRefreshToken(userId);
    // 写入新的 httpOnly cookie
    res.setCookie("refresh_token", newRefreshToken);

    res.sendResponse({ data: { jwtToken: newJwtToken } });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleLoginOrRegister,
  handleLogoutUser,
  handleRefreshToken,
  handleVerifyEmail,
  handleCheckLoginStatus,
  handleResendVerificationEmail,
  // getCsrfToken,
  // checkCsrfToken,
};
