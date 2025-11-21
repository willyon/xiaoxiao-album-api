/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const imageService = require("../services/imageService");
const CustomError = require("../errors/customError");
const { ERROR_CODES, SUCCESS_CODES } = require("../constants/messageCodes");
const { getRedisClient } = require("../services/redisClient");
const { ensureUserSetReady, userSetKey } = require("../workers/userImageHashset");
const { updateProgress } = require("../services/imageProcessingProgressService");
const logger = require("../utils/logger");

// 分页获取所有图片信息
async function handleGetAllByPage(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize } = req.body;
  try {
    // 分页获取数据库中所有已存储图片信息（默认包含完整URL）
    const queryResult = await imageService.getAllImagesByPage({ userId, pageNo, pageSize });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

//分页获取具体某个年份的图片
async function handleGetByCertainYear(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize, yearKey } = req.body;
  try {
    const queryResult = await imageService.getImagesByYear({ userId, pageNo, pageSize, yearKey });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}
//分页获取具体某个月份的图片
async function handleGetByCertainMonth(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize, monthKey } = req.body;
  try {
    const queryResult = await imageService.getImagesByMonth({ userId, pageNo, pageSize, monthKey });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

//分页获取具体某个日期的图片
async function handleGetByCertainDate(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize, dateKey } = req.body;
  try {
    const queryResult = await imageService.getImagesByDate({ userId, pageNo, pageSize, dateKey });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

// 分页获取按年份分组数据
async function handleGroupByYear(req, res, next) {
  const { userId } = req?.user;
  const { pageSize, pageNo } = req.body;

  try {
    // 分页获取数据
    const queryResult = await imageService.getGroupsByYear({ userId, pageSize, pageNo });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

// 分页获取按月份分组数据
async function handleGroupByMonth(req, res, next) {
  const { userId } = req?.user;
  const { pageSize, pageNo } = req.body;
  try {
    // 分页获取数据
    const queryResult = await imageService.getGroupsByMonth({ userId, pageSize, pageNo });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

// 分页获取按日期分组数据
async function handleGroupByDate(req, res, next) {
  const { userId } = req?.user;
  const { pageSize, pageNo } = req.body;
  try {
    // 分页获取数据
    const queryResult = await imageService.getGroupsByDate({ userId, pageSize, pageNo });

    res.sendResponse({ data: { list: queryResult.data, total: queryResult.total } });
  } catch (error) {
    next(error);
  }
}

/**
 * 预检文件是否存在 - 通用图片检查接口
 * POST /images/checkFileExists
 * Body: { hash }
 *
 * 作用：检查指定哈希的图片是否已存在，用于前端预检和秒传功能
 */
async function handleCheckFileExists(req, res, next) {
  try {
    const { hash, sessionId } = req.body;
    const userId = req?.user?.userId;

    if (!hash) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
      });
    }

    // 确保用户的 Redis hash 集合已初始化
    await ensureUserSetReady(userId);

    // 使用 Redis 检查文件是否已存在
    const redisClient = getRedisClient();
    const setKey = userSetKey(userId);
    const exists = await redisClient.sismember(setKey, hash);

    if (exists === 1) {
      // 文件已存在
      logger.info({
        message: "File exists check: found existing file",
        details: { userId, imageHash: hash },
      });

      // 如果有sessionId，更新已存在文件计数
      if (sessionId) {
        await updateProgress({
          sessionId,
          status: "existingFiles",
        });
      }

      return res.sendResponse({
        data: { exists: true },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    } else {
      // 文件不存在
      return res.sendResponse({
        data: { exists: false },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleGetAllByPage,
  handleGetByCertainYear,
  handleGetByCertainMonth,
  handleGetByCertainDate,
  handleGroupByYear,
  handleGroupByMonth,
  handleGroupByDate,
  handleCheckFileExists,
};
