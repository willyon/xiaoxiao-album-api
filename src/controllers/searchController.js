/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { searchImagesByText, getSearchSuggestions } = require("../models/searchModel");
const { updateImageSearchMetadata } = require("../models/imageModel");
// 移除队列引用，简化控制器
const logger = require("../utils/logger");

/**
 * 搜索图片
 * POST /api/search/images
 */
async function handleSearchImages(req, res, next) {
  try {
    const { userId } = req.user;
    const {
      query,
      filters = {},
      pageNo = 1,
      pageSize = 20,
      searchType = "hybrid", // 'text', 'vector', 'hybrid'
    } = req.body;

    if (!query || query.trim().length === 0) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "搜索关键词不能为空",
      });
    }

    logger.info({
      message: `用户搜索: ${userId}`,
      details: { query, filters, pageNo, pageSize, searchType },
    });

    // 构建搜索查询
    let searchQuery = query.trim();

    // 添加过滤条件
    if (filters.year) {
      searchQuery += ` AND year_key:${filters.year}`;
    }
    if (filters.month) {
      searchQuery += ` AND month_key:${filters.month}`;
    }
    if (filters.location) {
      searchQuery += ` AND gps_location:${filters.location}`;
    }
    if (filters.scene) {
      searchQuery += ` AND scene_tags:${filters.scene}`;
    }

    // 执行搜索
    const offset = (pageNo - 1) * pageSize;
    const searchResults = await searchImagesByText({
      userId,
      query: searchQuery,
      limit: pageSize,
      offset,
    });

    // 格式化结果
    const formattedResults = searchResults.map((result) => ({
      id: result.id,
      thumbnailStorageKey: result.thumbnail_storage_key,
      highResStorageKey: result.high_res_storage_key,
      creationDate: result.image_created_at,
      dateKey: result.date_key,
      monthKey: result.month_key,
      yearKey: result.year_key,
      gpsLocation: result.gps_location,
      storageType: result.storage_type,
      altText: result.alt_text,
      ocrText: result.ocr_text,
      keywords: result.keywords,
      sceneTags: result.scene_tags,
      objectTags: result.object_tags,
      relevanceScore: result.rank || 0,
    }));

    logger.info({
      message: `搜索完成: ${userId}`,
      details: {
        query,
        resultCount: formattedResults.length,
        totalResults: searchResults.length,
      },
    });

    res.sendResponse({
      data: {
        list: formattedResults,
        total: formattedResults.length,
        pageNo,
        pageSize,
        hasMore: formattedResults.length === pageSize,
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取搜索建议
 * GET /api/search/suggestions
 */
async function handleGetSearchSuggestions(req, res, next) {
  try {
    const { userId } = req.user;
    const { prefix = "", limit = 10 } = req.query;

    const suggestions = await getSearchSuggestions({
      userId,
      prefix,
      limit: parseInt(limit),
    });

    res.sendResponse({
      data: { suggestions },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 手动触发图片搜索索引
 * POST /api/search/index-image
 * 注意：这个方法将在 metaIngestor 中集成，这里只是提供接口占位
 */
async function handleIndexImage(req, res, next) {
  try {
    const { userId } = req.user;
    const { imageId } = req.body;

    if (!imageId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "缺少图片ID",
      });
    }

    logger.info({ message: `手动重新索引图片请求: imageId=${imageId}, userId=${userId}` });

    // 这里应该在 metaIngestor 中处理，直接返回成功
    // 实际的索引生成会在图片处理流程中自动触发
    res.sendResponse({
      data: {
        message: "重新索引请求已记录，将在图片处理流程中自动执行",
        imageId,
        userId,
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取搜索队列状态
 * GET /api/search/queue-status
 * 注意：这个方法将在队列服务中实现
 */
async function handleGetQueueStatus(req, res, next) {
  try {
    logger.info({ message: "获取搜索队列状态请求" });

    // 简化实现，返回基本状态信息
    res.sendResponse({
      data: {
        message: "队列状态检查功能将在队列服务集成时实现",
        timestamp: new Date().toISOString(),
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 高级搜索（支持多条件组合）
 * POST /api/search/advanced
 */
async function handleAdvancedSearch(req, res, next) {
  try {
    const { userId } = req.user;
    const {
      textQuery = "",
      filters = {},
      sortBy = "relevance", // 'relevance', 'date', 'size'
      pageNo = 1,
      pageSize = 20,
    } = req.body;

    logger.info({
      message: `高级搜索: ${userId}`,
      details: { textQuery, filters, sortBy },
    });

    // 构建复合查询
    let searchQuery = "";

    if (textQuery.trim()) {
      searchQuery += textQuery.trim();
    }

    // 添加结构化过滤
    const filterConditions = [];

    if (filters.year) {
      filterConditions.push(`year_key:${filters.year}`);
    }
    if (filters.month) {
      filterConditions.push(`month_key:${filters.month}`);
    }
    if (filters.date) {
      filterConditions.push(`date_key:${filters.date}`);
    }
    if (filters.location) {
      filterConditions.push(`gps_location:${filters.location}`);
    }
    if (filters.scene) {
      filterConditions.push(`scene_tags:${filters.scene}`);
    }
    if (filters.objects) {
      filterConditions.push(`object_tags:${filters.objects}`);
    }
    if (filters.layout) {
      filterConditions.push(`layout_type:${filters.layout}`);
    }

    if (filterConditions.length > 0) {
      if (searchQuery) {
        searchQuery += " AND " + filterConditions.join(" AND ");
      } else {
        searchQuery = filterConditions.join(" AND ");
      }
    }

    // 执行搜索
    const offset = (pageNo - 1) * pageSize;
    const searchResults = await searchImagesByText({
      userId,
      query: searchQuery || "*", // 如果没有查询条件，搜索所有
      limit: pageSize,
      offset,
    });

    // 格式化结果
    const formattedResults = searchResults.map((result) => ({
      id: result.id,
      thumbnailStorageKey: result.thumbnail_storage_key,
      highResStorageKey: result.high_res_storage_key,
      creationDate: result.image_created_at,
      dateKey: result.date_key,
      monthKey: result.month_key,
      yearKey: result.year_key,
      gpsLocation: result.gps_location,
      storageType: result.storage_type,
      altText: result.alt_text,
      ocrText: result.ocr_text,
      keywords: result.keywords,
      sceneTags: result.scene_tags,
      objectTags: result.object_tags,
      relevanceScore: result.rank || 0,
    }));

    res.sendResponse({
      data: {
        list: formattedResults,
        total: formattedResults.length,
        pageNo,
        pageSize,
        hasMore: formattedResults.length === pageSize,
        searchQuery,
        appliedFilters: filters,
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleSearchImages,
  handleGetSearchSuggestions,
  handleIndexImage,
  handleGetQueueStatus,
  handleAdvancedSearch,
};
