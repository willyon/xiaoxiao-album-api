/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:45:00
 * @Description: File description
 */
const imageService = require("../services/imageService");

// 提取工具函数：为图片添加 Base URL
function _addBaseUrlToImages(baseUrl, images) {
  return images.map((image) => ({
    ...image,
    highResUrl: `${baseUrl}${image.highResUrl}`,
    thumbnailUrl: `${baseUrl}${image.thumbnailUrl}`,
  }));
}

// 提取工具函数：为按年/按月份组数据封面图片添加 Base URL
function _addBaseUrlToGroupCover(baseUrl, groups) {
  return groups.map((group) => {
    return {
      ...group,
      latestImageUrl: `${baseUrl}${group.latestImageUrl}`,
    };
  });
}

function _getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// 分页获取所有图片信息
async function handleGetAllByPage(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize } = req.body;
  try {
    // 分页获取数据库中所有已存储图片信息
    const queryResult = await imageService.getAllImagesByPage({ userId, pageNo, pageSize });

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = _addBaseUrlToImages(baseUrl, queryResult.data);

    res.sendResponse({ data: { list: imagesWithBaseUrl, total: queryResult.total } });
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

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = _addBaseUrlToImages(baseUrl, queryResult.data);
    res.sendResponse({ data: { list: imagesWithBaseUrl, total: queryResult.total } });
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

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = _addBaseUrlToImages(baseUrl, queryResult.data);
    res.sendResponse({ data: { list: imagesWithBaseUrl, total: queryResult.total } });
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

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const groupsWithBaseUrl = _addBaseUrlToGroupCover(baseUrl, queryResult.data);
    res.sendResponse({ data: { list: groupsWithBaseUrl, total: queryResult.total } });
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

    // 资源地址 用于图片访问地址拼接
    const baseUrl = _getBaseUrl(req);

    // 为每张图片添加服务器基本路径
    const groupsWithBaseUrl = _addBaseUrlToGroupCover(baseUrl, queryResult.data);
    res.sendResponse({ data: { list: groupsWithBaseUrl, total: queryResult.total } });
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
