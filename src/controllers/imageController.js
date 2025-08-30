/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const imageService = require("../services/imageService");

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

module.exports = {
  handleGetAllByPage,
  handleGetByCertainYear,
  handleGetByCertainMonth,
  handleGroupByYear,
  handleGroupByMonth,
};
