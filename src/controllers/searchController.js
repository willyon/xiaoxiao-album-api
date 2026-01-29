/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 搜索功能API控制器
 */

const CustomError = require("../errors/customError");
const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const { COLOR_THEME_FRONTEND_TO_BACKEND, AGE_GROUP_FRONTEND_TO_BACKEND } = require("../constants/filterMappings");
const searchService = require("../services/searchService");
const { addFullUrlToImage } = require("../services/imageService");
const pythonSearchClient = require("../services/pythonSearchClient");
const { parseQueryIntent, mergeFilters } = require("../utils/queryIntentParser");
// 移除队列引用，简化控制器
const logger = require("../utils/logger");

/**
 * 构建 FTS 查询和 WHERE 条件
 * @param {string} query - 用户搜索关键词
 * @param {Object} filters - 筛选条件（可能包含前端值，需要转换为后端值）
 * @returns {Object} { ftsQuery, whereConditions, whereParams }
 * @returns {string|null} ftsQuery - FTS 查询字符串（如果为 null，则不使用 FTS）
 * @returns {Array<string>} whereConditions - WHERE 条件数组
 * @returns {Array} whereParams - WHERE 条件参数
 */
function buildSearchConditions(query, filters) {
  // 将前端值转换为后端值（创建一个新的 filters 对象，避免修改原始对象）
  const convertedFilters = { ...filters };

  // 转换颜色主题：前端3分类 → 后端5分类
  if (convertedFilters.colorTheme && Array.isArray(convertedFilters.colorTheme) && convertedFilters.colorTheme.length > 0) {
    const backendValues = new Set();
    convertedFilters.colorTheme.forEach((frontendTheme) => {
      const backendThemeValues = COLOR_THEME_FRONTEND_TO_BACKEND[frontendTheme] || [frontendTheme];
      backendThemeValues.forEach((val) => backendValues.add(val));
    });
    convertedFilters.colorTheme = Array.from(backendValues);
  }

  // 转换年龄段：前端5分类 → 后端9分类
  if (convertedFilters.ageGroup && Array.isArray(convertedFilters.ageGroup) && convertedFilters.ageGroup.length > 0) {
    const backendValues = new Set();
    convertedFilters.ageGroup.forEach((frontendAge) => {
      const backendAgeValues = AGE_GROUP_FRONTEND_TO_BACKEND[frontendAge] || [frontendAge];
      backendAgeValues.forEach((val) => backendValues.add(val));
    });
    convertedFilters.ageGroup = Array.from(backendValues);
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

  // 2. 表情（expression_tags 字段在 images 表中）
  // 注意：避免 FTS 子串/分词导致的误匹配，使用 WHERE 精确匹配逗号分隔标签
  if (filters.expression && Array.isArray(filters.expression) && filters.expression.length > 0) {
    const exprConditions = [];
    filters.expression.forEach((expr) => {
      exprConditions.push("(i.expression_tags = ? OR i.expression_tags LIKE ? OR i.expression_tags LIKE ? OR i.expression_tags LIKE ?)");
      whereParams.push(`${expr}`, `${expr},%`, `%,${expr},%`, `%,${expr}`);
    });
    if (exprConditions.length > 0) {
      whereConditions.push(`(${exprConditions.join(" OR ")})`);
    }
  }

  // 3. 性别（gender_tags 字段在 images 表中）
  // 注意：避免 "male" 命中 "female" 的子串问题，使用 WHERE 精确匹配逗号分隔标签
  if (filters.gender && filters.gender !== "" && filters.gender !== "all") {
    whereConditions.push("(i.gender_tags = ? OR i.gender_tags LIKE ? OR i.gender_tags LIKE ? OR i.gender_tags LIKE ?)");
    whereParams.push(`${filters.gender}`, `${filters.gender},%`, `%,${filters.gender},%`, `%,${filters.gender}`);
  }

  // 4. 图片版式（layout_type 字段在 FTS 中）
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

  // 5. AI分析状态（新增筛选项）
  if (filters.aiAnalysisStatus && filters.aiAnalysisStatus !== "" && filters.aiAnalysisStatus !== "all") {
    if (filters.aiAnalysisStatus === "analyzed") {
      // 已识别：face_count不为NULL（已完成AI分析）
      whereConditions.push("i.face_count IS NOT NULL");
    } else if (filters.aiAnalysisStatus === "notAnalyzed") {
      // 待识别：face_count为NULL（未进行AI分析）
      whereConditions.push("i.face_count IS NULL");
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
        personConditions.push("i.person_count = 0");
      } else if (count === "one") {
        personConditions.push("i.person_count = 1");
      } else if (count === "two") {
        personConditions.push("i.person_count = 2");
      } else if (count === "threePlus") {
        personConditions.push("i.person_count >= 3");
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
      whereConditions.push("i.face_count > 0");
    } else if (filters.faceVisibility === "notVisible") {
      // 无清晰人脸：已分析且无人脸
      whereConditions.push("i.face_count = 0");
    }
  }

  // 10. 年龄段（多选，前端5分类 → 后端9分类）
  // 注意：由于 age_tags 包含连字符（如 "0-2"），FTS5 无法正确解析
  // 因此使用 WHERE 条件和 LIKE 查询，而不是 FTS MATCH
  if (filters.ageGroup && Array.isArray(filters.ageGroup) && filters.ageGroup.length > 0) {
    const ageConditions = [];

    // 为每个年龄段添加 LIKE 条件
    filters.ageGroup.forEach((age) => {
      // 使用 LIKE 查询，精确匹配逗号分隔的标签
      // 匹配情况：
      // 1. 完全匹配：age_tags = "0-2"
      // 2. 开头匹配：age_tags = "0-2,20-29"
      // 3. 中间匹配：age_tags = "20-29,0-2,30-39"
      // 4. 结尾匹配：age_tags = "20-29,0-2"
      ageConditions.push(`(i.age_tags = ? OR i.age_tags LIKE ? OR i.age_tags LIKE ? OR i.age_tags LIKE ?)`);
      whereParams.push(`${age}`, `${age},%`, `%,${age},%`, `%,${age}`);
    });

    // 将所有年龄段条件用 OR 连接
    if (ageConditions.length > 0) {
      whereConditions.push(`(${ageConditions.join(" OR ")})`);
    }
  }

  // 11. 分辨率
  if (filters.resolution && Array.isArray(filters.resolution) && filters.resolution.length > 0) {
    const resConditions = [];
    filters.resolution.forEach((res) => {
      if (res === "hd") {
        // HD/标清：低于FHD标准（不满足1920×1080或1080×1920）
        resConditions.push("(NOT ((i.width_px >= 1920 AND i.height_px >= 1080) OR (i.width_px >= 1080 AND i.height_px >= 1920)))");
      } else if (res === "fhd1080p") {
        resConditions.push("((i.width_px >= 1920 AND i.height_px >= 1080) OR (i.width_px >= 1080 AND i.height_px >= 1920))");
      } else if (res === "4k") {
        resConditions.push("((i.width_px >= 3840 AND i.height_px >= 2160) OR (i.width_px >= 2160 AND i.height_px >= 3840))");
      } else if (res === "8k") {
        resConditions.push("((i.width_px >= 7680 AND i.height_px >= 4320) OR (i.width_px >= 4320 AND i.height_px >= 7680))");
      }
    });
    if (resConditions.length > 0) {
      whereConditions.push(`(${resConditions.join(" OR ")})`);
    }
  }

  // 12. 颜色主题
  if (filters.colorTheme && Array.isArray(filters.colorTheme) && filters.colorTheme.length > 0) {
    const placeholders = filters.colorTheme.map(() => "?").join(",");
    whereConditions.push(`i.color_theme IN (${placeholders})`);
    whereParams.push(...filters.colorTheme);
  }

  // 13. 上传时间
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

  return {
    ftsQuery,
    whereConditions,
    whereParams,
  };
}

/**
 * 合并 FTS 和向量搜索结果，使用倒数排名融合（RRF）排序
 * @param {Array} ftsResults - FTS 搜索结果（包含 id 字段）
 * @param {Array<{image_id: number, score: number}>} vectorResults - 向量搜索结果
 * @param {number} k - RRF 常数（默认 60）
 * @returns {Array<{imageId: number, rrfScore: number}>} 合并排序后的结果
 */
function mergeAndRank(ftsResults, vectorResults, k = 60) {
  // 创建 imageId -> rank 的映射
  const ftsRankMap = new Map();
  ftsResults.forEach((result, index) => {
    ftsRankMap.set(result.id, index + 1); // rank 从 1 开始
  });

  const vectorRankMap = new Map();
  vectorResults.forEach((result, index) => {
    vectorRankMap.set(result.image_id, index + 1);
  });

  // 收集所有唯一的 imageId
  const allImageIds = new Set();
  ftsResults.forEach((result) => allImageIds.add(result.id));
  vectorResults.forEach((result) => allImageIds.add(result.image_id));

  // 计算每个 imageId 的 RRF 分数
  const scoredResults = [];
  allImageIds.forEach((imageId) => {
    const ftsRank = ftsRankMap.get(imageId) || Infinity;
    const vectorRank = vectorRankMap.get(imageId) || Infinity;

    // RRF 公式：score = 1/(k + rank_fts) + 1/(k + rank_vector)
    const rrfScore = 1 / (k + ftsRank) + 1 / (k + vectorRank);

    scoredResults.push({
      imageId,
      rrfScore,
    });
  });

  // 按 RRF 分数降序排序
  scoredResults.sort((a, b) => b.rrfScore - a.rrfScore);

  return scoredResults;
}

/**
 * 搜索图片
 * POST /search/images
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

    // 允许空查询或通配符查询（用于纯筛选或查询所有图片）
    let searchQuery = query && query.trim() ? query.trim() : "*";
    const hasQuery = searchQuery !== "*" && searchQuery.trim() !== "";

    // 解析查询意图，自动填充筛选条件（不覆盖用户已设置的筛选）
    let enhancedFilters = { ...filters };
    if (hasQuery) {
      const parsedIntent = parseQueryIntent(searchQuery);
      enhancedFilters = mergeFilters(filters, parsedIntent);

      // 如果有场景关键词，将其添加到查询文本中（通过 FTS 匹配）
      if (parsedIntent._sceneKeywords && parsedIntent._sceneKeywords.length > 0) {
        // 场景关键词通过 FTS 查询处理，不需要修改 filters
        // 这些关键词会在 FTS 匹配时自动命中 scene_tags 字段
      }
    }

    logger.info({
      message: `用户搜索: ${userId}`,
      details: {
        query: searchQuery,
        originalFilters: filters,
        enhancedFilters,
        pageNo,
        pageSize,
        searchType,
      },
    });

    // 构建搜索条件（使用增强后的 filters）
    const { ftsQuery, whereConditions, whereParams } = buildSearchConditions(searchQuery, enhancedFilters);

    logger.info({
      message: "搜索条件构建完成",
      details: { ftsQuery, whereConditionsCount: whereConditions.length, whereParamsCount: whereParams.length },
    });

    // 执行搜索
    const offset = (pageNo - 1) * pageSize;

    // 并行执行 FTS 搜索和向量搜索（如果有查询词）
    const searchPromises = [
      // FTS 搜索：获取更多结果用于合并（取 pageSize * 2，确保有足够的结果用于 RRF）
      searchService.searchImagesByText({
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
            vectorResults: vectorResults.slice(0, 5).map((r) => ({ image_id: r.image_id, score: r.score })),
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
        const uniqueVectorIds = Array.from(new Set(vectorResults.map((r) => r.image_id)));
        try {
          const vectorImages = await searchService.getImagesByIds({
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

        // 创建 imageId -> 完整结果对象的映射（FTS 结果）
        const ftsResultsMap = new Map();
        ftsResults.forEach((result) => {
          ftsResultsMap.set(result.id, result);
        });

        // 收集需要从数据库获取的图片 ID（只在向量结果中出现的）
        const vectorImageIds = new Set(vectorResults.map((r) => r.image_id));
        const ftsImageIds = new Set(ftsResults.map((r) => r.id));
        const missingImageIds = Array.from(vectorImageIds).filter((id) => !ftsImageIds.has(id));

        // 如果有只在向量结果中的图片，从数据库获取
        let vectorOnlyImages = [];
        if (missingImageIds.length > 0) {
          try {
            vectorOnlyImages = await searchService.getImagesByIds({
              userId,
              imageIds: missingImageIds,
            });
            // 添加到映射中
            vectorOnlyImages.forEach((img) => {
              ftsResultsMap.set(img.id, img);
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

        for (const { imageId } of mergedRanks) {
          if (mergedImageIds.has(imageId)) continue;

          const result = ftsResultsMap.get(imageId);
          if (result) {
            mergedResults.push(result);
            mergedImageIds.add(imageId);
          }
        }

        finalResults = mergedResults;
        // 总数：FTS 和向量结果的并集大小（去重后的 imageId 数量）
        const allUniqueImageIds = new Set([...ftsResults.map((r) => r.id), ...vectorResults.map((r) => r.image_id)]);
        finalTotal = Math.max(ftsTotalCount, allUniqueImageIds.size);
      }
    }

    // 分页（如果之前取了更多结果）
    if (hasQuery && vectorResults.length > 0) {
      finalResults = finalResults.slice(offset, offset + pageSize);
    }

    // 添加完整URL（thumbnailUrl 和 highResUrl）
    const resultsWithUrls = await addFullUrlToImage(finalResults);

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
 * 高级搜索（支持多条件组合）
 * POST /search/advanced
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
    // 构建 FTS 查询：如果有条件则使用，否则为 null（不使用 FTS）
    const finalFtsQuery = searchQuery || null;

    const searchResults = await searchService.searchImagesByText({
      userId,
      ftsQuery: finalFtsQuery,
      whereConditions: [],
      whereParams: [],
      limit: pageSize,
      offset,
    });

    // 添加完整URL（thumbnailUrl 和 highResUrl）
    // isFavorite字段已从数据库直接返回，searchResults 已经通过 mapFields 转换为 camelCase
    const resultsWithUrls = await addFullUrlToImage(searchResults);

    res.sendResponse({
      data: {
        list: resultsWithUrls,
        total: resultsWithUrls.length,
        pageNo,
        pageSize,
        hasMore: resultsWithUrls.length === pageSize,
        searchQuery,
        appliedFilters: filters,
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
 */
async function handleGetFilterOptionsPaginated(req, res, next) {
  try {
    const { userId } = req.user;
    const { type, pageNo = 1, pageSize = 20, timeDimension = null } = req.query;

    if (!type || !["city", "year", "month", "weekday"].includes(type)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_REQUEST_PARAMS,
        messageType: "error",
        message: "type 参数必须是 city、year、month 或 weekday",
      });
    }

    logger.info({
      message: `分页获取筛选选项: ${userId}`,
      details: { type, pageNo, pageSize },
    });

    const result = await searchService.getFilterOptionsPaginated({
      userId,
      type,
      pageNo: parseInt(pageNo),
      pageSize: parseInt(pageSize),
      timeDimension,
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
  handleSearchImages,
  handleGetSearchSuggestions,
  handleIndexImage,
  handleGetQueueStatus,
  handleAdvancedSearch,
  handleGetFilterOptionsPaginated,
};
