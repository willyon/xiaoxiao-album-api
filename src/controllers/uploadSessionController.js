/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理控制器
 */
const { createSession, getActiveSession } = require("../services/uploadSessionService");
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");

/**
 * 处理创建上传会话请求
 */
const handleCreateSession = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const session = await createSession(userId);

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: session,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 处理获取活跃会话请求
 * GET /api/uploads/sessions/active
 */
const handleGetActiveSession = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const activeSession = await getActiveSession(userId);

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: activeSession,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleCreateSession,
  handleGetActiveSession,
};
