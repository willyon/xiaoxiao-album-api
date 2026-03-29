/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const searchService = require("../services/searchService");
const { addFullUrlToMedia } = require("../services/mediaService");
const faceClusterModel = require("../models/faceClusterModel");
const logger = require("../utils/logger");
const { buildSearchQueryParts } = require("../utils/buildSearchQueryParts");

/**
 * 根据 source + scope 构建「范围」条件（用于统一列表与按维度筛选选项）
 * 返回的 whereConditions 使用表别名 "i."，可直接与 buildSearchQueryParts 的结果合并。
 * @param {Object} scope - { source, type?, albumId?, clusterId? }
 * @param {number} userId - 用户ID
 * @returns {{ scopeConditions: string[], scopeParams: any[] }}
 */
function buildScopeConditions(scope, userId) {
  const scopeConditions = [];
  const scopeParams = [];
  if (!scope || !scope.source) return { scopeConditions, scopeParams };

  const { source, type, albumId, clusterId } = scope;

  switch (source) {
    case "favorites":
      scopeConditions.push("i.is_favorite = 1");
      break;
    case "timeline":
      if (type === "year" && albumId != null) {
        scopeConditions.push("i.year_key = ?");
        scopeParams.push(String(albumId));
      } else if (type === "month" && albumId != null) {
        scopeConditions.push("i.month_key = ?");
        scopeParams.push(String(albumId));
      } else if (type === "unknown") {
        scopeConditions.push(
          "(i.year_key = 'unknown' AND i.month_key = 'unknown' AND i.date_key = 'unknown' AND i.day_key = 'unknown')"
        );
      }
      break;
    case "album":
      if (albumId != null && albumId !== "") {
        const aid = parseInt(albumId, 10);
        if (!Number.isNaN(aid)) {
          scopeConditions.push("i.id IN (SELECT media_id FROM album_media WHERE album_id = ?)");
          scopeParams.push(aid);
        }
      }
      break;
    case "location":
      if (albumId == null || albumId === "") break;
      if (albumId === "unknown") {
        scopeConditions.push("(i.city IS NULL OR i.city = '' OR i.city = 'unknown')");
      } else {
        scopeConditions.push("i.city = ?");
        scopeParams.push(String(albumId));
      }
      break;
    case "people":
      if (clusterId != null && !Number.isNaN(Number(clusterId)) && userId != null) {
        scopeConditions.push(
          "i.id IN (SELECT mfe.media_id FROM media_face_embeddings mfe INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id WHERE fc.user_id = ? AND fc.cluster_id = ?)"
        );
        scopeParams.push(userId, Number(clusterId));
      }
      break;
    case "search":
    default:
      break;
  }

  return { scopeConditions, scopeParams };
}

/**
 * 搜索/列表图片（统一接口）
 * POST /search/media
 * body: query?, filters?, pageNo, pageSize, clusterId?
 *       可选 scope：source?, type?, albumId?（传了 source 且不为 search 时在范围内列表/搜索；未传或 source=search 为全局搜索）
 */
async function handleSearchMedias(req, res, next) {
  try {
    const { userId } = req.user;
    const {
      query,
      filters = {},
      pageNo = 1,
      pageSize = 20,
      clusterId: clusterIdRaw,
      source,
      type,
      albumId,
    } = req.body;

    const clusterId = clusterIdRaw != null && clusterIdRaw !== "" ? parseInt(clusterIdRaw, 10) : null;
    const validClusterId = Number.isNaN(clusterId) ? null : clusterId;

    const validSources = ["search", "favorites", "timeline", "album", "location", "people"];
    const hasScope = source && source !== "search" && validSources.includes(source);

    let searchQuery = query && query.trim() ? query.trim() : "*";
    const hasQuery = searchQuery !== "*" && searchQuery.trim() !== "";

    const filterOptions = { userId, clusterId: validClusterId };

    logger.info({
      message: hasScope ? `范围列表/搜索: ${userId}` : `用户搜索: ${userId}`,
      details: {
        query: searchQuery,
        filters,
        pageNo,
        pageSize,
        clusterId: validClusterId,
        source: hasScope ? source : null,
      },
    });

    let searchResult;

    if (hasScope) {
      const scope = { source, type, albumId, clusterId: validClusterId };
      const { scopeConditions, scopeParams } = buildScopeConditions(scope, userId);
      if (hasQuery) {
        searchResult = await searchService.searchMediaResults({
          userId,
          query: searchQuery,
          baseFilters: filters,
          filterOptions,
          scopeConditions,
          scopeParams,
          pageNo: parseInt(pageNo, 10),
          pageSize: parseInt(pageSize, 10),
        });
      } else {
        const filterBuilt = buildSearchQueryParts(filters, filterOptions);
        searchResult = await searchService.searchMediaResults({
          userId,
          query: "",
          whereConditions: [...scopeConditions, ...filterBuilt.whereConditions],
          whereParams: [...scopeParams, ...filterBuilt.whereParams],
          pageNo: parseInt(pageNo, 10),
          pageSize: parseInt(pageSize, 10),
        });
      }
      let resultsWithUrls = await addFullUrlToMedia(searchResult.list);
      if (source === "people" && validClusterId != null && resultsWithUrls.length > 0) {
        const mediaIds = resultsWithUrls.map((item) => item.mediaId).filter((id) => id != null);
        const faceEmbeddingIdMap = faceClusterModel.getFaceEmbeddingIdByMediaIdInCluster(userId, validClusterId, mediaIds);
        resultsWithUrls = resultsWithUrls.map((item) => ({
          ...item,
          faceEmbeddingId: faceEmbeddingIdMap.get(item.mediaId) ?? null,
        }));
      }
      logger.info({
        message: `范围列表/搜索完成: ${userId}`,
        details: { source, resultCount: resultsWithUrls.length, total: searchResult.total },
      });
      return res.sendResponse({
        data: { list: resultsWithUrls, total: searchResult.total },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }

    // 全局搜索：有关键词时整句在 searchService 内解析（空格视为同一句内多线索，不拆成多次搜索）；无关键词时仅筛选列表
    if (hasQuery) {
      searchResult = await searchService.searchMediaResults({
        userId,
        query: searchQuery,
        baseFilters: filters,
        filterOptions,
        scopeConditions: [],
        scopeParams: [],
        pageNo: parseInt(pageNo, 10),
        pageSize: parseInt(pageSize, 10),
      });
    } else {
      const built = buildSearchQueryParts(filters, filterOptions);
      searchResult = await searchService.searchMediaResults({
        userId,
        query: "",
        whereConditions: built.whereConditions,
        whereParams: built.whereParams,
        pageNo: parseInt(pageNo, 10),
        pageSize: parseInt(pageSize, 10),
      });
    }

    const resultsWithUrls = await addFullUrlToMedia(searchResult.list);

    logger.info({
      message: `搜索完成: ${userId}`,
      details: {
        query,
        resultCount: resultsWithUrls.length,
        totalCount: searchResult.total,
        termCount: searchResult.stats?.termCount || 0,
        ftsCount: searchResult.stats?.ftsCount || 0,
        appliedFilters: Object.keys(filters).filter((key) => {
          const value = filters[key];
          if (Array.isArray(value)) return value.length > 0;
          return value && value !== "" && value !== "all";
        }),
      },
    });

    res.sendResponse({
      data: {
        list: resultsWithUrls,
        total: searchResult.total,
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取搜索队列状态
 * GET /search/queue-status
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
 * 分页获取筛选选项（用于滚动加载）
 * GET /search/filters?type=city&pageNo=1&pageSize=20
 * 可选 scope：scopeSource, scopeType, scopeAlbumId, scopeClusterId（与统一列表的 source/scope 一致，用于在当前维度下获取选项）
 */
async function handleGetFilterOptionsPaginated(req, res, next) {
  try {
    const { userId } = req.user;
    const {
      type,
      pageNo = 1,
      pageSize = 20,
      timeDimension = null,
      mediaType = "all",
      scopeSource,
      scopeType,
      scopeAlbumId,
      scopeClusterId,
    } = req.query;

    if (!type || !["city", "year", "month", "weekday"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        message: "type 参数必须是 city、year、month 或 weekday",
      });
    }

    let scopeConditions = [];
    let scopeParams = [];
    if (scopeSource) {
      const scope = {
        source: scopeSource,
        type: scopeType,
        albumId: scopeAlbumId,
        clusterId: scopeClusterId,
      };
      const built = buildScopeConditions(scope, userId);
      scopeConditions = built.scopeConditions;
      scopeParams = built.scopeParams;
    }

    logger.info({
      message: `分页获取筛选选项: ${userId}`,
      details: { type, pageNo, pageSize, scopeSource: scopeSource || null },
    });

    const result = await searchService.getFilterOptionsPaginated({
      userId,
      type,
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
      timeDimension,
      mediaType: ["image", "video"].includes(mediaType) ? mediaType : null,
      scopeConditions: scopeConditions.length ? scopeConditions : null,
      scopeParams: scopeParams.length ? scopeParams : null,
    });

    res.sendResponse({
      data: result,
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    logger.error({
      message: "分页获取筛选选项失败",
      error: error.message,
      stack: error.stack,
    });
    next(error);
  }
}

module.exports = {
  handleSearchMedias,
  handleGetQueueStatus,
  handleGetFilterOptionsPaginated,
  buildScopeConditions,
};
