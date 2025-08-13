/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:14
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-12 16:16:39
 * @Description: File description
 */
const imageService = require("../services/imageService");

// 提取工具函数：为图片添加 Base URL
function _addBaseUrlToImages(baseUrl, images) {
  return images.map((image) => ({
    ...image,
    bigHighQualityImageUrl: `${baseUrl}${image.bigHighQualityImageUrl}`,
    bigLowQualityImageUrl: `${baseUrl}${image.bigLowQualityImageUrl}`,
    previewImageUrl: `${baseUrl}${image.previewImageUrl}`,
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

//分页获取具体某个时间段的图片
async function handleGetByTimeRange(req, res, next) {
  const { userId } = req?.user;
  const { pageNo, pageSize, creationDate, timeRange } = req.body;
  try {
    // 分页获取数据库中具体某个月已存储图片信息
    const queryResult = await imageService.getImagesByTimeRange({ userId, pageNo, pageSize, creationDate, timeRange });

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
  handleGetByTimeRange,
  handleGroupByYear,
  handleGroupByMonth,
};
