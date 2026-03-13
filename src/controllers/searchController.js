/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { AGE_GROUP_FRONTEND_TO_BACKEND } = require("../constants/filterMappings");
const searchService = require("../services/searchService");
const { addFullUrlToMedia } = require("../services/mediaService");
const faceClusterModel = require("../models/faceClusterModel");
const pythonSearchClient = require("../services/pythonSearchClient");
const { parseQueryIntent, mergeFilters } = require("../utils/queryIntentParser");
// 移除队列引用，简化控制器
const logger = require("../utils/logger");

const ALLOWED_EXPRESSION_FILTERS = new Set(["happy", "sad", "anger", "surprise", "neutral"]);

/**
 * 构建 FTS 查询和 WHERE 条件
 * @param {string} query - 用户搜索关键词
 * @param {Object} filters - 筛选条件（可能包含前端值，需要转换为后端值）
 * @param {Object} [options] - 可选，{ userId, clusterId } 当 clusterId 存在时限定在人物相册内
 * @returns {Object} { ftsQuery, whereConditions, whereParams }
 * @returns {string|null} ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @returns {Array<string>} whereConditions - WHERE 条件数组
 * @returns {Array} whereParams - WHERE 条件参数
 */
function buildSearchConditions(query, filters, options = {}) {
  // 将前端值转换为后端值（创建一个新的 filters 对象，避免修改原始对象）
  const convertedFilters = { ...filters };

  // 转换年龄段：前端5分类 → 后端9分类
  if (convertedFilters.ageGroup && Array.isArray(convertedFilters.ageGroup) && convertedFilters.ageGroup.length > 0) {
    const backendValues = new Set();
    convertedFilters.ageGroup.forEach((frontendAge) => {
      const backendAgeValues = AGE_GROUP_FRONTEND_TO_BACKEND[frontendAge] || [frontendAge];
      backendAgeValues.forEach((val) => backendValues.add(val));
    });
    convertedFilters.ageGroup = Array.from(backendValues);
  }

  // 收敛表情筛选：仅保留主筛选支持的高频稳定类别
  if (Array.isArray(convertedFilters.expression)) {
    convertedFilters.expression = convertedFilters.expression.filter((expr) => ALLOWED_EXPRESSION_FILTERS.has(expr));
  }

  // 使用转换后的 filters 进行后续处理
  filters = convertedFilters;

  // FTS 查询部分（用于 MATCH 子句）
  const ftsConditions = [];
  const isWildcardQuery = !query || query.trim() === "" || query.trim() === "*";

  // WHERE 条件部分（用于数值和范围查询）
  const whereConditions = [];
  const whereParams = [];

  // ========== 处理 FTS 支持的字段 ==========

  // 1. 地点（city 字段：使用 WHERE 条件进行精确匹配，不使用 FTS）
  // 原因：城市名称是精确值，FTS5 对中文分词可能导致误匹配（如"深圳市"可能匹配到"广州市"）
  if (filters.location && Array.isArray(filters.location) && filters.location.length > 0) {
    const hasUnknown = filters.location.includes("unknown");
    const knownCities = filters.location.filter((city) => city !== "unknown");

    if (knownCities.length > 0 && hasUnknown) {
      // 同时选择了具体城市和"地点未知"
      const cityPlaceholders = knownCities.map(() => "?").join(",");
      whereConditions.push(`(i.city IN (${cityPlaceholders}) OR i.city IS NULL OR i.city = '' OR i.city = 'unknown')`);
      whereParams.push(...knownCities);
    } else if (knownCities.length > 0) {
      // 只选择了具体城市：使用 WHERE 条件进行精确匹配
      const cityPlaceholders = knownCities.map(() => "?").join(",");
      whereConditions.push(`i.city IN (${cityPlaceholders})`);
      whereParams.push(...knownCities);
    } else if (hasUnknown) {
      // 只选择了"地点未知"
      whereConditions.push("(i.city IS NULL OR i.city = '' OR i.city = 'unknown')");
    }
  }

  // 2. 表情（media_analysis.primary_expression）
  // 注意：避免 FTS 子串/分词导致的误匹配，使用 WHERE 精确匹配逗号分隔标签
  if (filters.expression && Array.isArray(filters.expression) && filters.expression.length > 0) {
    const exprConditions = [];
    filters.expression.forEach((expr) => {
      exprConditions.push("ma.primary_expression = ?");
      whereParams.push(`${expr}`);
    });
    if (exprConditions.length > 0) {
      whereConditions.push(`(${exprConditions.join(" OR ")})`);
    }
  }

  // 2.1 场景（media_analysis.scene_primary）
  if (filters.scene && Array.isArray(filters.scene) && filters.scene.length > 0) {
    const sceneConditions = [];
    filters.scene.forEach((scene) => {
      sceneConditions.push("ma.scene_primary = ?");
      whereParams.push(scene);
    });
    if (sceneConditions.length > 0) {
      whereConditions.push(`(${sceneConditions.join(" OR ")})`);
    }
  }

  // 2.2 物体（media_objects.label）
  if (filters.object && Array.isArray(filters.object) && filters.object.length > 0) {
    const placeholders = filters.object.map(() => "?").join(",");
    whereConditions.push(`
      EXISTS (
        SELECT 1 FROM media_objects mo
        WHERE mo.media_id = i.id
          AND mo.label IN (${placeholders})
      )
    `);
    whereParams.push(...filters.object);
  }

  // 3. 图片版式（layout_type 字段在 FTS 中）
  if (filters.imageOrientation && Array.isArray(filters.imageOrientation) && filters.imageOrientation.length > 0) {
    const layoutConditions = filters.imageOrientation.map((layout) => `layout_type:${layout}`).join(" OR ");
    ftsConditions.push(`(${layoutConditions})`);
  }

  // 构建最终的 FTS 查询字符串
  let ftsQuery;

  if (isWildcardQuery) {
    // 如果是通配符查询（查询所有）
    if (ftsConditions.length > 0) {
      // 有 FTS 筛选条件，只使用筛选条件
      ftsQuery = ftsConditions.join(" AND ");
    } else {
      // 没有 FTS 筛选条件，不使用 FTS，直接查询 images 表
      ftsQuery = null;
    }
  } else {
    // 有具体的搜索关键词
    ftsQuery = query.trim();
    if (ftsConditions.length > 0) {
      ftsQuery += " AND " + ftsConditions.join(" AND ");
    }
  }

  // ========== 处理 WHERE 子句字段 ==========

  // 4.5. 媒体类型（图片/视频）
  if (filters.mediaType && ["image", "video"].includes(filters.mediaType)) {
    whereConditions.push("(i.media_type = ? OR ? = 'all')");
    whereParams.push(filters.mediaType, filters.mediaType);
  }

  // 5. AI分析状态（新增筛选项）
  if (filters.aiAnalysisStatus && filters.aiAnalysisStatus !== "" && filters.aiAnalysisStatus !== "all") {
    if (filters.aiAnalysisStatus === "analyzed") {
      // 已识别：face_count不为NULL（已完成AI分析）
      whereConditions.push("ma.analysis_status = 'done'");
    } else if (filters.aiAnalysisStatus === "notAnalyzed") {
      // 待识别：face_count为NULL（未进行AI分析）
      whereConditions.push("(ma.media_id IS NULL OR ma.analysis_status != 'done')");
    }
  }

  // 5.1 是否含文字（基于 media_search.ocr_text）
  if (filters.hasText && filters.hasText !== "" && filters.hasText !== "all") {
    if (filters.hasText === "withText") {
      whereConditions.push(`
        EXISTS (
          SELECT 1 FROM media_search ms2
          WHERE ms2.media_id = i.id
            AND ms2.ocr_text IS NOT NULL
            AND TRIM(ms2.ocr_text) != ''
        )
      `);
    } else if (filters.hasText === "withoutText") {
      whereConditions.push(`
        NOT EXISTS (
          SELECT 1 FROM media_search ms2
          WHERE ms2.media_id = i.id
            AND ms2.ocr_text IS NOT NULL
            AND TRIM(ms2.ocr_text) != ''
        )
      `);
    }
  }

  // 6. 时间维度 + 选中的时间值
  // 6.1. 时间未知维度（独立处理）
  if (filters.timeDimension === "unknown") {
    // 只筛选时间未知的图片（所有时间字段都是 unknown）
    whereConditions.push("(i.year_key = 'unknown' AND i.month_key = 'unknown' AND i.date_key = 'unknown' AND i.day_key = 'unknown')");
  }
  // 6.2. 其他时间维度（年/月/星期）
  else if (filters.timeDimension && filters.selectedTimeValues && filters.selectedTimeValues.length > 0) {
    const knownValues = filters.selectedTimeValues;

    if (filters.timeDimension === "year") {
      const placeholders = knownValues.map(() => "?").join(",");
      whereConditions.push(`i.year_key IN (${placeholders})`);
      whereParams.push(...knownValues);
    } else if (filters.timeDimension === "month") {
      const placeholders = knownValues.map(() => "?").join(",");
      whereConditions.push(`i.month_key IN (${placeholders})`);
      whereParams.push(...knownValues);
    } else if (filters.timeDimension === "weekday") {
      const placeholders = knownValues.map(() => "?").join(",");
      whereConditions.push(`i.day_key IN (${placeholders})`);
      whereParams.push(...knownValues);
    }
  }

  // 7. 自定义日期范围
  if (filters.customDateRange && Array.isArray(filters.customDateRange) && filters.customDateRange.length === 2) {
    // 只选日期范围
    whereConditions.push("i.date_key BETWEEN ? AND ?");
    whereParams.push(filters.customDateRange[0], filters.customDateRange[1]);
  }

  // 8. 人物数量（基于 person_count，多选）
  // 注意：person_count = NULL 表示未分析，只统计已分析的图片
  if (filters.personCount && Array.isArray(filters.personCount) && filters.personCount.length > 0) {
    const personConditions = [];
    filters.personCount.forEach((count) => {
      if (count === "zero") {
        // 无人物：已分析且结果为0
        personConditions.push("COALESCE(ma.person_count, 0) = 0");
      } else if (count === "one") {
        personConditions.push("COALESCE(ma.person_count, 0) = 1");
      } else if (count === "two") {
        personConditions.push("COALESCE(ma.person_count, 0) = 2");
      } else if (count === "threePlus") {
        personConditions.push("COALESCE(ma.person_count, 0) >= 3");
      }
    });
    if (personConditions.length > 0) {
      whereConditions.push(`(${personConditions.join(" OR ")})`);
    }
  }

  // 9. 人脸可见性（基于 face_count，单选）
  // 注意：face_count = NULL 表示未分析，只统计已分析的图片
  if (filters.faceVisibility) {
    if (filters.faceVisibility === "visible") {
      // 清晰人脸：有人脸（已分析且>0）
      whereConditions.push("COALESCE(ma.face_count, 0) > 0");
    } else if (filters.faceVisibility === "notVisible") {
      // 无清晰人脸：已分析且无人脸
      whereConditions.push("COALESCE(ma.face_count, 0) = 0");
    }
  }

  // 10. 年龄段（通过 media_face_embeddings.age 匹配）
  if (filters.ageGroup && Array.isArray(filters.ageGroup) && filters.ageGroup.length > 0) {
    const ageRangeMap = {
      "0-2": [0, 2],
      "3-12": [3, 12],
      "13-19": [13, 19],
      "20-29": [20, 29],
      "30-39": [30, 39],
      "40-49": [40, 49],
      "50-59": [50, 59],
      "60-69": [60, 69],
      "70+": [70, 200],
    };
    const ageRangeConditions = [];
    filters.ageGroup.forEach((age) => {
      const range = ageRangeMap[age];
      if (!range) return;
      ageRangeConditions.push("(mfe.age BETWEEN ? AND ?)");
      whereParams.push(range[0], range[1]);
    });
    if (ageRangeConditions.length > 0) {
      whereConditions.push(`
        EXISTS (
          SELECT 1 FROM media_face_embeddings mfe
          WHERE mfe.media_id = i.id
            AND (${ageRangeConditions.join(" OR ")})
        )
      `);
    }
  }

  // 11. 分辨率
  if (filters.resolution && Array.isArray(filters.resolution) && filters.resolution.length > 0) {
    const resConditions = [];
    filters.resolution.forEach((res) => {
      if (res === "sd") {
        // 标清：低于FHD标准（不满足1920×1080或1080×1920）
        resConditions.push("(NOT ((i.width_px >= 1920 AND i.height_px >= 1080) OR (i.width_px >= 1080 AND i.height_px >= 1920)))");
      } else if (res === "fhd") {
        resConditions.push("((i.width_px >= 1920 AND i.height_px >= 1080) OR (i.width_px >= 1080 AND i.height_px >= 1920))");
      } else if (res === "uhd4k") {
        resConditions.push("((i.width_px >= 3840 AND i.height_px >= 2160) OR (i.width_px >= 2160 AND i.height_px >= 3840))");
      } else if (res === "uhd8k") {
        resConditions.push("((i.width_px >= 7680 AND i.height_px >= 4320) OR (i.width_px >= 4320 AND i.height_px >= 7680))");
      }
    });
    if (resConditions.length > 0) {
      whereConditions.push(`(${resConditions.join(" OR ")})`);
    }
  }

  // 12. 导入时间
  if (filters.uploadTime && filters.uploadTime !== "" && filters.uploadTime !== "all") {
    const now = Date.now();
    let timeThreshold;

    if (filters.uploadTime === "last24hours") {
      timeThreshold = now - 86400000; // 24小时
    } else if (filters.uploadTime === "lastWeek") {
      timeThreshold = now - 604800000; // 7天
    } else if (filters.uploadTime === "lastMonth") {
      timeThreshold = now - 2592000000; // 30天
    } else if (filters.uploadTime === "lastYear") {
      timeThreshold = now - 31536000000; // 365天
    }

    if (timeThreshold) {
      whereConditions.push("i.created_at >= ?");
      whereParams.push(timeThreshold);
    }
  }

  // 13. 视频时长（仅视频）
  if (filters.videoDuration && filters.videoDuration !== "" && filters.videoDuration !== "all") {
    whereConditions.push("i.media_type = 'video'");
    if (filters.videoDuration === "ultraShort") {
      whereConditions.push("COALESCE(i.duration_sec, 0) > 0 AND i.duration_sec <= 15");
    } else if (filters.videoDuration === "short") {
      whereConditions.push("i.duration_sec > 15 AND i.duration_sec <= 60");
    } else if (filters.videoDuration === "medium") {
      whereConditions.push("i.duration_sec > 60 AND i.duration_sec <= 300");
    } else if (filters.videoDuration === "long") {
      whereConditions.push("i.duration_sec > 300 AND i.duration_sec <= 1200");
    } else if (filters.videoDuration === "veryLong") {
      whereConditions.push("i.duration_sec > 1200");
    }
  }

  // 14. 人物范围（可选 clusterId：仅查询该人脸聚类下的图片）
  const clusterId = options.clusterId != null ? Number(options.clusterId) : null;
  if (clusterId != null && !Number.isNaN(clusterId) && options.userId != null) {
    whereConditions.push(
      "i.id IN (SELECT mfe.media_id FROM media_face_embeddings mfe INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id WHERE fc.user_id = ? AND fc.cluster_id = ?)",
    );
    whereParams.push(options.userId, clusterId);
  }

  return {
    ftsQuery,
    whereConditions,
    whereParams,
  };
}

/**
 * 根据 source + scope 构建「范围」条件（用于统一列表与按维度筛选选项）
 * 返回的 whereConditions 使用表别名 "i."，可直接与 buildSearchConditions 的结果合并。
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
 * 合并 FTS 和向量搜索结果，使用倒数排名融合（RRF）排序
 * @param {Array} ftsResults - FTS 搜索结果（包含 id 字段）
 * @param {Array<{media_id: number, score: number}>} vectorResults - 向量搜索结果
 * @param {number} k - RRF 常数（默认 60）
 * @returns {Array<{mediaId: number, rrfScore: number}>} 合并排序后的结果
 */
function mergeAndRank(ftsResults, vectorResults, k = 60) {
  // 创建 mediaId -> rank 的映射
  const ftsRankMap = new Map();
  ftsResults.forEach((result, index) => {
    ftsRankMap.set(result.mediaId, index + 1); // rank 从 1 开始
  });

  const vectorRankMap = new Map();
  vectorResults.forEach((result, index) => {
    vectorRankMap.set(result.media_id, index + 1);
  });

  // 收集所有唯一的 mediaId
  const allMediaIds = new Set();
  ftsResults.forEach((result) => allMediaIds.add(result.mediaId));
  vectorResults.forEach((result) => allMediaIds.add(result.media_id));

  // 计算每个 mediaId 的 RRF 分数
  const scoredResults = [];
  allMediaIds.forEach((mediaId) => {
    const ftsRank = ftsRankMap.get(mediaId) || Infinity;
    const vectorRank = vectorRankMap.get(mediaId) || Infinity;

    // RRF 公式：score = 1/(k + rank_fts) + 1/(k + rank_vector)
    const rrfScore = 1 / (k + ftsRank) + 1 / (k + vectorRank);

    scoredResults.push({
      mediaId,
      rrfScore,
    });
  });

  // 按 RRF 分数降序排序
  scoredResults.sort((a, b) => b.rrfScore - a.rrfScore);

  return scoredResults;
}

/**
 * 搜索/列表图片（统一接口）
 * POST /search/media
 * body: query?, filters?, pageNo, pageSize, clusterId?
 *       可选 scope：source?, type?, albumId?（传了 source 且不为 search 时在范围内列表/搜索，不做向量；未传或 source=search 为全局搜索，有 query 时做向量）
 */
async function handleSearchMedias(req, res, next) {
  try {
    const { userId } = req.user;
    const {
      query,
      filters = {},
      pageNo = 1,
      pageSize = 20,
      searchType = "hybrid",
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

    let enhancedFilters = { ...filters };
    if (hasQuery) {
      const parsedIntent = parseQueryIntent(searchQuery);
      enhancedFilters = mergeFilters(filters, parsedIntent);
    }

    logger.info({
      message: hasScope ? `范围列表/搜索: ${userId}` : `用户搜索: ${userId}`,
      details: {
        query: searchQuery,
        filters: enhancedFilters,
        pageNo,
        pageSize,
        clusterId: validClusterId,
        source: hasScope ? source : null,
      },
    });

    const offset = (pageNo - 1) * pageSize;
    let whereConditions = [];
    let whereParams = [];
    let ftsQuery = null;

    if (hasScope) {
      const scope = { source, type, albumId, clusterId: validClusterId };
      const { scopeConditions, scopeParams } = buildScopeConditions(scope, userId);
      const filterOptions = { userId };
      const filterBuilt = buildSearchConditions(hasQuery ? searchQuery : "*", enhancedFilters, filterOptions);
      ftsQuery = filterBuilt.ftsQuery;
      whereConditions = [...scopeConditions, ...filterBuilt.whereConditions];
      whereParams = [...scopeParams, ...filterBuilt.whereParams];

      const [list, total] = await Promise.all([
        searchService.searchMediasByText({
          userId,
          ftsQuery,
          whereConditions,
          whereParams,
          limit: pageSize,
          offset,
        }),
        searchService.getSearchResultsCount({
          userId,
          ftsQuery,
          whereConditions,
          whereParams,
        }),
      ]);
      let resultsWithUrls = await addFullUrlToMedia(list);
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
        details: { source, resultCount: resultsWithUrls.length, total },
      });
      return res.sendResponse({
        data: { list: resultsWithUrls, total },
        messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
      });
    }

    // 全局搜索（无 scope 或 source=search）：原有逻辑，含向量
    const filterOptions = { userId, clusterId: validClusterId };
    const built = buildSearchConditions(searchQuery, enhancedFilters, filterOptions);
    ftsQuery = built.ftsQuery;
    whereConditions = built.whereConditions;
    whereParams = built.whereParams;

    logger.info({
      message: "搜索条件构建完成",
      details: { ftsQuery, whereConditionsCount: whereConditions.length, whereParamsCount: whereParams.length },
    });

    const searchPromises = [
      // FTS 搜索：获取更多结果用于合并（取 pageSize * 2，确保有足够的结果用于 RRF）
      searchService.searchMediasByText({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
        limit: hasQuery ? pageSize * 2 : pageSize, // 有查询词时多取一些用于合并
        offset: hasQuery ? 0 : offset, // 有查询词时从 0 开始，合并后再分页
      }),
      searchService.getSearchResultsCount({
        userId,
        ftsQuery,
        whereConditions,
        whereParams,
      }),
    ];

    // 如果有查询词，执行向量搜索
    let vectorResults = [];
    if (hasQuery) {
      try {
        // 1. 文本编码
        const { vector: queryVector } = await pythonSearchClient.encodeText(searchQuery);

        // 2. 基于 ANN 索引的向量搜索（由 Python 侧 hnswlib 完成，不再传输所有候选向量）
        vectorResults = await pythonSearchClient.annSearchByVector(userId, queryVector, pageSize * 2);

        logger.info({
          message: "向量搜索完成（ANN）",
          details: {
            query: searchQuery,
            queryVectorLength: queryVector.length,
            vectorResultsCount: vectorResults.length,
            vectorResults: vectorResults.slice(0, 5).map((r) => ({ media_id: r.media_id, score: r.score })),
          },
        });
      } catch (error) {
        // Python 服务失败时降级为仅 FTS，记录日志但不中断流程
        logger.warn({
          message: "向量搜索失败，降级为仅 FTS",
          details: {
            error: error.message,
            query: searchQuery,
          },
        });
      }
    }

    // 等待 FTS 搜索完成
    const [ftsResults, ftsTotalCount] = await Promise.all(searchPromises);

    let finalResults = ftsResults;
    let finalTotal = ftsTotalCount;

    // 如果有向量搜索结果，合并排序
    if (hasQuery && vectorResults.length > 0) {
      // 情况 1：FTS 没有命中，但向量搜索有结果 —— 直接按向量结果取图片列表
      if (ftsResults.length === 0) {
        const uniqueVectorIds = Array.from(new Set(vectorResults.map((r) => r.media_id)));
        try {
          const vectorImages = await searchService.getMediasByIds({
            userId,
            imageIds: uniqueVectorIds,
          });

          finalResults = vectorImages;
          finalTotal = vectorImages.length;

          logger.info({
            message: "搜索结果：仅向量命中",
            details: {
              query: searchQuery,
              imageCount: vectorImages.length,
            },
          });
        } catch (error) {
          logger.warn({
            message: "仅向量命中场景下获取图片信息失败，降级为无结果",
            details: { error: error.message, imageIds: uniqueVectorIds },
          });
          finalResults = [];
          finalTotal = 0;
        }
      } else {
        // 情况 2：FTS 和向量都有结果，使用 RRF 合并
        const mergedRanks = mergeAndRank(ftsResults, vectorResults);

        // 创建 mediaId -> 完整结果对象的映射（FTS 结果）
        const ftsResultsMap = new Map();
        ftsResults.forEach((result) => {
          ftsResultsMap.set(result.mediaId, result);
        });

        // 收集需要从数据库获取的图片 ID（只在向量结果中出现的）
        const vectorImageIds = new Set(vectorResults.map((r) => r.media_id));
        const ftsImageIds = new Set(ftsResults.map((r) => r.mediaId));
        const missingImageIds = Array.from(vectorImageIds).filter((id) => !ftsImageIds.has(id));

        // 如果有只在向量结果中的图片，从数据库获取
        let vectorOnlyImages = [];
        if (missingImageIds.length > 0) {
          try {
            vectorOnlyImages = await searchService.getMediasByIds({
              userId,
              imageIds: missingImageIds,
            });
            // 添加到映射中
            vectorOnlyImages.forEach((img) => {
              ftsResultsMap.set(img.mediaId, img);
            });
          } catch (error) {
            logger.warn({
              message: "获取向量结果图片信息失败",
              details: { error: error.message, missingImageIds },
            });
          }
        }

        // 按 RRF 排序后的顺序构建最终结果
        const mergedResults = [];
        const mergedImageIds = new Set();

        for (const { mediaId } of mergedRanks) {
          if (mergedImageIds.has(mediaId)) continue;

          const result = ftsResultsMap.get(mediaId);
          if (result) {
            mergedResults.push(result);
            mergedImageIds.add(mediaId);
          }
        }

        finalResults = mergedResults;
        // 总数：FTS 和向量结果的并集大小（去重后的 mediaId 数量）
        const allUniqueImageIds = new Set([...ftsResults.map((r) => r.mediaId), ...vectorResults.map((r) => r.media_id)]);
        finalTotal = Math.max(ftsTotalCount, allUniqueImageIds.size);
      }
    }

    // 分页（如果之前取了更多结果）
    if (hasQuery && vectorResults.length > 0) {
      finalResults = finalResults.slice(offset, offset + pageSize);
    }

    // 添加完整URL（thumbnailUrl 和 highResUrl）
    const resultsWithUrls = await addFullUrlToMedia(finalResults);

    logger.info({
      message: `搜索完成: ${userId}`,
      details: {
        query,
        resultCount: resultsWithUrls.length,
        totalCount: finalTotal,
        ftsCount: ftsResults.length,
        vectorCount: vectorResults.length,
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
        total: finalTotal,
      },
      messageCode: SUCCESS_CODES.REQUEST_COMPLETED,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 获取搜索建议
 * GET /search/suggestions
 */
async function handleGetSearchSuggestions(req, res, next) {
  try {
    const { userId } = req.user;
    const { prefix = "", limit = 10 } = req.query;

    const suggestions = await searchService.getSearchSuggestions({
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
 * POST /search/index-image
 * 注意：这个方法将在 metaIngestor 中集成，这里只是提供接口占位
 */
async function handleIndexImage(req, res, next) {
  try {
    const { userId } = req.user;
    const { mediaId } = req.body;

    if (!mediaId) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        message: "缺少媒体ID",
      });
    }

    logger.info({ message: `手动重新索引媒体请求: mediaId=${mediaId}, userId=${userId}` });

    // 这里应该在 metaIngestor 中处理，直接返回成功
    // 实际的索引生成会在图片处理流程中自动触发
    res.sendResponse({
      data: {
        message: "重新索引请求已记录，将在图片处理流程中自动执行",
        mediaId,
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

    if (!type || !["city", "year", "month", "weekday", "scene", "object"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "error",
        message: "type 参数必须是 city、year、month、weekday、scene 或 object",
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

/**
 * 分页获取场景筛选选项
 * GET /search/filters/scenes?pageNo=1&pageSize=20
 */
async function handleGetSceneFilterOptionsPaginated(req, res, next) {
  req.query.type = "scene";
  return handleGetFilterOptionsPaginated(req, res, next);
}

/**
 * 分页获取物体筛选选项
 * GET /search/filters/objects?pageNo=1&pageSize=20
 */
async function handleGetObjectFilterOptionsPaginated(req, res, next) {
  req.query.type = "object";
  return handleGetFilterOptionsPaginated(req, res, next);
}

module.exports = {
  handleSearchMedias,
  handleGetSearchSuggestions,
  handleIndexMedia,
  handleGetQueueStatus,
  handleGetFilterOptionsPaginated,
  handleGetSceneFilterOptionsPaginated,
  handleGetObjectFilterOptionsPaginated,
  buildScopeConditions,
};
