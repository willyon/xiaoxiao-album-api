/*
 * @Description: 由筛选条件构建 WHERE（供无关键词列表与自然搜索里筛选合并共用）。有关键词时的全文检索在 searchService 内单独构造 MATCH 串，不经本函数。
 * 地点筛选依赖 options.locationKeyExpr（表别名 i 上的地点键 SQL 表达式），须由 searchService 经 mediaModel 注入，保持 controller→service→model。
 */
const { AGE_GROUP_FRONTEND_TO_BACKEND } = require("../constants/filterMappings");

const ALLOWED_EXPRESSION_FILTERS = new Set(["happy", "sad", "anger", "surprise", "neutral"]);

/**
 * @param {Object} filters - 筛选条件
 * @param {Object} [options] - { userId, clusterId, locationKeyExpr? }
 */
function buildSearchQueryParts(filters, options = {}) {
  const convertedFilters = { ...filters };

  if (convertedFilters.ageGroup && Array.isArray(convertedFilters.ageGroup) && convertedFilters.ageGroup.length > 0) {
    const backendValues = new Set();
    convertedFilters.ageGroup.forEach((frontendAge) => {
      const backendAgeValues = AGE_GROUP_FRONTEND_TO_BACKEND[frontendAge] || [frontendAge];
      backendAgeValues.forEach((val) => backendValues.add(val));
    });
    convertedFilters.ageGroup = Array.from(backendValues);
  }

  if (Array.isArray(convertedFilters.expression)) {
    convertedFilters.expression = convertedFilters.expression.filter((expr) => ALLOWED_EXPRESSION_FILTERS.has(expr));
  }

  filters = convertedFilters;

  const whereConditions = [];
  const whereParams = [];

  if (filters.location && Array.isArray(filters.location) && filters.location.length > 0) {
    const locKey = options.locationKeyExpr;
    if (!locKey || typeof locKey !== "string") {
      throw new Error("buildSearchQueryParts: options.locationKeyExpr is required when filters.location is set");
    }
    const hasUnknown = filters.location.includes("unknown");
    const knownLocations = filters.location.filter((city) => city !== "unknown");

    if (knownLocations.length > 0 && hasUnknown) {
      const ph = knownLocations.map(() => "?").join(",");
      whereConditions.push(`((${locKey}) IN (${ph}) OR (${locKey}) IS NULL)`);
      whereParams.push(...knownLocations);
    } else if (knownLocations.length > 0) {
      const ph = knownLocations.map(() => "?").join(",");
      whereConditions.push(`(${locKey}) IN (${ph})`);
      whereParams.push(...knownLocations);
    } else if (hasUnknown) {
      whereConditions.push(`(${locKey}) IS NULL`);
    }
  }

  if (filters.expression && Array.isArray(filters.expression) && filters.expression.length > 0) {
    const exprConditions = [];
    filters.expression.forEach((expr) => {
      // 以 media.expression_tags 为准（入库时由多人脸表情合并写入，逗号分隔）
      exprConditions.push(
        "(',' || REPLACE(COALESCE(i.expression_tags, ''), ' ', '') || ',') LIKE '%,' || ? || ',%'",
      );
      whereParams.push(expr);
    });
    if (exprConditions.length > 0) {
      whereConditions.push(`(${exprConditions.join(" OR ")})`);
    }
  }

  if (filters.imageOrientation && Array.isArray(filters.imageOrientation) && filters.imageOrientation.length > 0) {
    const placeholders = filters.imageOrientation.map(() => "?").join(",");
    whereConditions.push(`i.layout_type IN (${placeholders})`);
    whereParams.push(...filters.imageOrientation);
  }

  if (filters.mediaType && ["image", "video"].includes(filters.mediaType)) {
    whereConditions.push("(i.media_type = ? OR ? = 'all')");
    whereParams.push(filters.mediaType, filters.mediaType);
  }

  if (filters.aiAnalysisStatus && filters.aiAnalysisStatus !== "" && filters.aiAnalysisStatus !== "all") {
    // 旧逻辑依赖 media.analysis_status（已废弃），这里改为使用 analysis_status_primary：
    // - analyzed: 主分析成功（success）
    // - notAnalyzed: 主分析未完成 / 失败 / 未开始
    if (filters.aiAnalysisStatus === "analyzed") {
      whereConditions.push("i.analysis_status_primary = 'success'");
    } else if (filters.aiAnalysisStatus === "notAnalyzed") {
      whereConditions.push("(i.analysis_status_primary IS NULL OR i.analysis_status_primary != 'success')");
    }
  }

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

  if (filters.timeDimension === "unknown") {
    whereConditions.push("(i.year_key = 'unknown' AND i.month_key = 'unknown' AND i.date_key = 'unknown' AND i.day_key = 'unknown')");
  } else if (filters.timeDimension && filters.selectedTimeValues && filters.selectedTimeValues.length > 0) {
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
    } else if (filters.timeDimension === "season") {
      const seasonMonths = {
        spring: ["03", "04", "05"],
        summer: ["06", "07", "08"],
        autumn: ["09", "10", "11"],
        winter: ["12", "01", "02"],
      };
      const months = new Set();
      knownValues.forEach((season) => {
        (seasonMonths[season] || []).forEach((m) => months.add(m));
      });
      if (months.size > 0) {
        const placeholders = [...months].map(() => "?").join(",");
        whereConditions.push(`SUBSTR(i.month_key, 6, 2) IN (${placeholders})`);
        whereParams.push(...months);
      }
    } else if (filters.timeDimension === "monthOfYear") {
      const normalized = knownValues
        .map((v) => String(v).padStart(2, "0"))
        .filter((v) => /^(0[1-9]|1[0-2])$/.test(v));
      if (normalized.length > 0) {
        const placeholders = normalized.map(() => "?").join(",");
        whereConditions.push(`SUBSTR(i.month_key, 6, 2) IN (${placeholders})`);
        whereParams.push(...normalized);
      }
    }
  }

  if (filters.customDateRange && Array.isArray(filters.customDateRange) && filters.customDateRange.length === 2) {
    whereConditions.push("i.date_key BETWEEN ? AND ?");
    whereParams.push(filters.customDateRange[0], filters.customDateRange[1]);
  }

  if (filters.personCount && Array.isArray(filters.personCount) && filters.personCount.length > 0) {
    const personConditions = [];
    filters.personCount.forEach((count) => {
      if (count === "zero") {
        personConditions.push("COALESCE(i.person_count, 0) = 0");
      } else if (count === "one") {
        personConditions.push("COALESCE(i.person_count, 0) = 1");
      } else if (count === "two") {
        personConditions.push("COALESCE(i.person_count, 0) = 2");
      } else if (count === "threePlus") {
        personConditions.push("COALESCE(i.person_count, 0) >= 3");
      }
    });
    if (personConditions.length > 0) {
      whereConditions.push(`(${personConditions.join(" OR ")})`);
    }
  }

  if (filters.faceVisibility) {
    if (filters.faceVisibility === "visible") {
      whereConditions.push("COALESCE(i.face_count, 0) > 0");
    } else if (filters.faceVisibility === "notVisible") {
      whereConditions.push("COALESCE(i.face_count, 0) = 0");
    }
  }

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

  if (filters.resolution && Array.isArray(filters.resolution) && filters.resolution.length > 0) {
    const resConditions = [];
    filters.resolution.forEach((res) => {
      if (res === "sd") {
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

  if (filters.uploadTime && filters.uploadTime !== "" && filters.uploadTime !== "all") {
    const now = Date.now();
    let timeThreshold;

    if (filters.uploadTime === "last24hours") {
      timeThreshold = now - 86400000;
    } else if (filters.uploadTime === "lastWeek") {
      timeThreshold = now - 604800000;
    } else if (filters.uploadTime === "lastMonth") {
      timeThreshold = now - 2592000000;
    } else if (filters.uploadTime === "lastYear") {
      timeThreshold = now - 31536000000;
    }

    if (timeThreshold) {
      whereConditions.push("i.created_at >= ?");
      whereParams.push(timeThreshold);
    }
  }

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

  const clusterId = options.clusterId != null ? Number(options.clusterId) : null;
  if (clusterId != null && !Number.isNaN(clusterId) && options.userId != null) {
    whereConditions.push(
      "i.id IN (SELECT mfe.media_id FROM media_face_embeddings mfe INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id WHERE fc.user_id = ? AND fc.cluster_id = ?)",
    );
    whereParams.push(options.userId, clusterId);
  }

  return {
    whereConditions,
    whereParams,
  };
}

module.exports = {
  buildSearchQueryParts,
};
