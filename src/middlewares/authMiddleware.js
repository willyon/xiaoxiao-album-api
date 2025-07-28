/*
 * @Author: zhangshouchang
 * @Date: 2025-02-15 00:43:34
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-26 17:26:51
 * @Description: File description
 */
const jwt = require("jsonwebtoken");
const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(
      new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.UNAUTHORIZED,
        messageType: "error",
        refreshable: false,
      }),
    );
  }

  const jwtToken = authHeader.split(" ")[1];
  try {
    // 若鉴权失败 则会跳到后面catch中 不会执行req.user......
    const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET);

    req.user = decoded; // req.user格式为{userId:userId}
    next();
  } catch (jwtError) {
    if (jwtError.name === "TokenExpiredError") {
      return next(
        new CustomError({
          httpStatus: 401,
          messageCode: ERROR_CODES.TOKEN_EXPIRED,
          messageType: "warning",
          refreshable: true, // 可尝试刷新jwt token
        }),
      );
    }

    return next(
      new CustomError({
        httpStatus: 401,
        messageCode: ERROR_CODES.INVALID_JWT_TOKEN,
        messageType: "error",
        refreshable: false,
      }),
    );
  }
};

module.exports = authMiddleware;
