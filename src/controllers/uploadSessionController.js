/*
 * @Author: zhangshouchang
 * @Date: 2025-01-20 10:00:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-20 10:00:00
 * @Description: 上传会话管理控制器
 */
const { createSession, getActiveSession, updateSessionData } = require("../services/uploadSessionService");
const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");

/**
 * 处理创建上传会话请求
 */
const handleCreateSession = async (req, res, next) => {
  try {
    const { totalCount } = req.body;
    const userId = req.user.userId;

    if (!totalCount || totalCount <= 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        details: "totalCount must be a positive number",
      });
    }

    const session = await createSession(userId, totalCount);

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

/**
 * 处理更新会话数据请求（统一接口）
 * PUT /api/uploads/sessions/:id/update
 */
const handleUpdateSessionData = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;
    const { uploadedCount, totalCount } = req.body;

    const updateData = {};
    if (uploadedCount !== undefined) {
      updateData.uploadedCount = uploadedCount;
    }
    if (totalCount !== undefined) {
      updateData.totalCount = totalCount;
    }

    const session = await updateSessionData(sessionId, updateData);

    res.sendResponse({
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      data: session,
    });
  } catch (error) {
    if (error.message === "Session not found") {
      return next(
        new CustomError({
          httpStatus: 404,
          messageCode: ERROR_CODES.UPLOAD_SESSION_NOT_FOUND,
          messageType: "error",
        }),
      );
    }
    next(error);
  }
};

module.exports = {
  handleCreateSession,
  handleGetActiveSession,
  handleUpdateSessionData,
};
