/*
 * @Description: face_clusters 与 media_face_embeddings、face_cluster_meta 等列表、统计与 ID 类查询
 */
/**
 * 人脸聚类查询模型：待聚类/未分配人脸、人物列表与统计、人物名列表、各类 embedding 与封面相关查询。
 */
const { db } = require('../../db')
const logger = require('../../utils/logger')

/**
 * 获取待自动聚类的人脸 embedding（排除已归属手动聚类的脸）
 * @param {number|string} userId 用户 ID
 * @returns {Array<{ id: number, mediaId: number, faceIndex: number, embedding: number[], userId: number }>}
 */
function getFaceEmbeddingsByUserId(userId) {
  // 排除已经在手动聚类中的 face_embedding（is_user_assigned = TRUE）
  // 这样可以避免手动聚类的图片在重新聚类时被重复分配到其他聚类中
  const sql = `
    SELECT 
      fe.id,
      fe.embedding,
      fe.media_id AS media_id,
      fe.face_index,
      m.user_id
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_clusters fc ON fe.id = fc.face_embedding_id 
      AND fc.user_id = ? 
      AND fc.is_user_assigned = TRUE
    WHERE m.user_id = ? 
      AND m.deleted_at IS NULL
      AND fc.face_embedding_id IS NULL  -- 排除已经在手动聚类中的记录
    ORDER BY fe.id ASC
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, userId);

  // 解析 embedding（从 BLOB 转换为数组）
  return rows.map((row) => ({
    id: row.id,
    mediaId: row.media_id,
    faceIndex: row.face_index,
    embedding: JSON.parse(row.embedding.toString()), // BLOB -> Buffer -> String -> Array
    userId: row.user_id,
  }));
}

/**
 * 聚类维度统计：人物数、总 face 行数、去重人脸数
 * @param {number|string} userId 用户 ID
 * @returns {{ clusterCount: number, totalFaces: number, uniqueFaceCount: number }}
 */
function getClusterStatsByUserId(userId) {
  const sql = `
    SELECT 
      COUNT(DISTINCT cluster_id) AS clusterCount,
      COUNT(*) AS totalFaces,
      COUNT(DISTINCT face_embedding_id) AS uniqueFaceCount
    FROM face_clusters
    WHERE user_id = ?
  `;

  const stmt = db.prepare(sql);
  const result = stmt.get(userId);

  return {
    clusterCount: result?.clusterCount || 0,
    totalFaces: result?.totalFaces || 0,
    uniqueFaceCount: result?.uniqueFaceCount || 0,
  };
}

const preparedStatements = {
  count: null,
  basic: null,
  cover: null,
  time: null,
};

/**
 * 批量查询并构建 cluster 封面映射。
 * @param {number|string} userId - 用户 ID。
 * @param {number[]} clusterIds - 聚类 ID 列表。
 * @returns {Map<number, {thumbnailStorageKey:string}>} cluster_id -> cover。
 */
function loadClusterCoverMap(userId, clusterIds) {
  const coversMap = new Map();
  if (!clusterIds || clusterIds.length === 0) return coversMap;
  const coverPlaceholders = clusterIds.map(() => "?").join(", ");
  const coverSql = `
    SELECT 
      fc.cluster_id,
      fe.face_thumbnail_storage_key,
      m.thumbnail_storage_key,
      fc.representative_type,
      fc.similarity_score
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id IN (${coverPlaceholders})
      AND m.deleted_at IS NULL
    ORDER BY fc.cluster_id, 
      CASE 
        WHEN fc.representative_type = 2 THEN 1
        WHEN fc.representative_type = 1 THEN 2
        ELSE 3
      END,
      fc.similarity_score DESC,
      fe.id ASC
  `;

  const coverRows = db.prepare(coverSql).all(userId, ...clusterIds);
  for (const row of coverRows) {
    if (coversMap.has(row.cluster_id)) continue;
    if (row.face_thumbnail_storage_key) {
      coversMap.set(row.cluster_id, { thumbnailStorageKey: row.face_thumbnail_storage_key });
    } else if (row.thumbnail_storage_key) {
      coversMap.set(row.cluster_id, { thumbnailStorageKey: row.thumbnail_storage_key });
    }
  }
  return coversMap;
}

/**
 * 批量查询并构建 cluster 时间范围映射。
 * @param {number|string} userId - 用户 ID。
 * @param {number[]} clusterIds - 聚类 ID 列表。
 * @returns {Map<number, {earliest:number, latest:number}>} cluster_id -> timeRange。
 */
function loadClusterTimeMap(userId, clusterIds) {
  const timeMap = new Map();
  if (!clusterIds || clusterIds.length === 0) return timeMap;
  const timePlaceholders = clusterIds.map(() => "?").join(", ");
  const timeSql = `
    SELECT 
      fc.cluster_id,
      MIN(m.captured_at) AS earliest_time,
      MAX(m.captured_at) AS latest_time
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id IN (${timePlaceholders})
      AND m.deleted_at IS NULL
    GROUP BY fc.cluster_id
  `;
  const timeRows = db.prepare(timeSql).all(userId, ...clusterIds);
  for (const row of timeRows) {
    timeMap.set(row.cluster_id, {
      earliest: row.earliest_time,
      latest: row.latest_time,
    });
  }
  return timeMap;
}

/**
 * 分页查询人物列表：名称、媒体数、封面、时间范围；支持按名称搜索与最近使用排序
 * @param {number|string} userId 用户 ID
 * @param {Object} [options] 分页与搜索
 * @param {number} [options.pageNo] 页码，从 1 开始
 * @param {number} [options.pageSize] 每页条数
 * @param {string|null} [options.search] 名称模糊搜索
 * @returns {{ list: Array<object>, total: number }} 列表与总条数
 */
function getClustersByUserId(userId, options = {}) {
  const { pageNo = 1, pageSize = 20, search = null } = options;
  const offset = (pageNo - 1) * pageSize;
  const searchTrimmed = search && typeof search === "string" ? search.trim() : null;
  const hasSearch = searchTrimmed && searchTrimmed.length > 0;
  const searchPattern = hasSearch ? `%${searchTrimmed}%` : null;

  let total;
  if (hasSearch) {
    const countSql = `
      SELECT COUNT(DISTINCT fc.cluster_id) AS total
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
    `;
    const countStmt = db.prepare(countSql);
    total = countStmt.get(userId, searchPattern)?.total || 0;
  } else {
    if (!preparedStatements.count) {
      const countSql = `
        SELECT COUNT(DISTINCT fc.cluster_id) AS total
        FROM face_clusters fc
        INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
        INNER JOIN media m ON fe.media_id = m.id
        WHERE fc.user_id = ?
          AND m.deleted_at IS NULL
      `;
      preparedStatements.count = db.prepare(countSql);
    }
    total = preparedStatements.count.get(userId)?.total || 0;
  }

  // 添加调试日志：检查数据库中的原始数据
  if (total === 0) {
    // 检查是否有任何聚类数据（不考虑过滤条件）
    const rawCountSql = `SELECT COUNT(DISTINCT cluster_id) AS total FROM face_clusters WHERE user_id = ?`;
    const rawCountStmt = db.prepare(rawCountSql);
    const rawTotal = rawCountStmt.get(userId)?.total || 0;

    // 检查是否有被过滤掉的数据（只检查软删除的图片）
    const filteredCountSql = `
      SELECT COUNT(DISTINCT fc.cluster_id) AS total
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NOT NULL
    `;
    const filteredCountStmt = db.prepare(filteredCountSql);
    const filteredTotal = filteredCountStmt.get(userId)?.total || 0;

    logger.info({
      message: "人物列表查询：数据库检查",
      details: {
        userId,
        rawTotal,
        filteredTotal,
        finalTotal: total,
        message: rawTotal > 0 ? `数据库中有 ${rawTotal} 个聚类，但可能被过滤条件过滤掉了（deleted_at）` : "数据库中确实没有任何聚类数据",
      },
    });

    return { list: [], total: 0 };
  }

  // 第一步：查询聚类基本信息（按 cluster_id 聚合；name 取非空名的 MAX，避免 GROUP BY name 拆成同一人物两行）

  // 如果 SQLite 不支持窗口函数，使用更简单的方式
  // 只查询必要的字段：cluster_id, name, mediaCount
  // 注意：必须使用与总数查询相同的过滤条件，确保数据一致性
  // 使用 COUNT(DISTINCT m.id) 统计照片数量，而不是人脸数量
  let basicRows;
  if (hasSearch) {
    const basicSqlSearchRecent = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount,
        MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
      GROUP BY fc.cluster_id
      ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    const basicSqlSearch = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM face_clusters fcx
          INNER JOIN media_face_embeddings fex ON fcx.face_embedding_id = fex.id
          INNER JOIN media mx ON fex.media_id = mx.id
          WHERE fcx.user_id = fc.user_id AND fcx.cluster_id = fc.cluster_id
            AND mx.deleted_at IS NULL
            AND fcx.name LIKE ?
        )
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    try {
      basicRows = db.prepare(basicSqlSearchRecent).all(userId, searchPattern, pageSize, offset);
    } catch (err) {
      logger.warn({ message: "getClustersByUserId 搜索使用默认排序", details: { error: err.message } });
      basicRows = db.prepare(basicSqlSearch).all(userId, searchPattern, pageSize, offset);
    }
  } else {
    // 只按 cluster_id 分组：name 在各行可能不一致（部分行 NULL），不能 GROUP BY cluster_id, name 否则同一人物会出现两行
    const basicSqlRecent = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount,
        MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
      GROUP BY fc.cluster_id
      ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    const basicSqlSimple = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE fc.user_id = ?
        AND m.deleted_at IS NULL
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ? OFFSET ?
    `;
    try {
      basicRows = db.prepare(basicSqlRecent).all(userId, pageSize, offset);
    } catch (err) {
      logger.warn({ message: "getClustersByUserId 使用默认排序（可能 face_cluster_meta 不存在）", details: { error: err.message } });
      if (!preparedStatements.basic) {
        preparedStatements.basic = db.prepare(basicSqlSimple);
      }
      basicRows = preparedStatements.basic.all(userId, pageSize, offset);
    }
  }

  if (basicRows.length === 0) {
    return { list: [], total };
  }

  const clusterIds = basicRows.map((row) => row.cluster_id);
  const coversMap = loadClusterCoverMap(userId, clusterIds);
  const timeMap = loadClusterTimeMap(userId, clusterIds);

  // 组装结果，只返回必要的字段
  const list = basicRows.map((row) => {
    const coverImage = coversMap.get(row.cluster_id) || null;
    const timeRange = timeMap.get(row.cluster_id) || null;

    return {
      clusterId: row.cluster_id,
      name: row.name || null,
      mediaCount: row.mediaCount,
      coverImage,
      timeRange,
    };
  });

  return { list, total };
}

/**
 * 单个人物聚类卡片，与 getClustersByUserId 列表项同结构（不含封面前端 URL，由 attachClusterCoverUrls 补全）
 * @param {number|string} userId
 * @param {number} clusterId
 * @returns {{ clusterId: number, name: string|null, mediaCount: number, coverImage: object|null, timeRange: object|null }|null}
 */
function getClusterCardByUserId(userId, clusterId) {
  const basicSql = `
    SELECT
      fc.cluster_id,
      MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
      COUNT(DISTINCT m.id) AS mediaCount
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
    GROUP BY fc.cluster_id
  `;
  const row = db.prepare(basicSql).get(userId, clusterId);
  if (!row) return null;
  const coversMap = loadClusterCoverMap(userId, [row.cluster_id]);
  const timeMap = loadClusterTimeMap(userId, [row.cluster_id]);
  return {
    clusterId: row.cluster_id,
    name: row.name || null,
    mediaCount: row.mediaCount,
    coverImage: coversMap.get(row.cluster_id) || null,
    timeRange: timeMap.get(row.cluster_id) || null,
  };
}

/**
 * 查询最近使用的人物子集（合并到其他人、选目标人物等场景），结构与 getClustersByUserId 列表项类似
 * @param {number|string} userId 用户 ID
 * @param {Object} [options]
 * @param {number} [options.limit] 条数上限（最大 20）
 * @param {number|string|null} [options.excludeClusterId] 排除的 cluster_id
 * @returns {{ list: Array<object>, total: number }}
 */
function getRecentClustersByUserId(userId, options = {}) {
  const { limit = 5, excludeClusterId = null } = options;
  const excludeId = excludeClusterId != null && excludeClusterId !== "" ? parseInt(excludeClusterId, 10) : null;

  let whereClause = "fc.user_id = ? AND m.deleted_at IS NULL";
  const params = [userId];
  if (excludeId != null && !Number.isNaN(excludeId)) {
    whereClause += " AND fc.cluster_id != ?";
    params.push(excludeId);
  }

  // 总数（排除项后）
  let countSql = `
    SELECT COUNT(DISTINCT fc.cluster_id) AS total
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE ${whereClause}
  `;
  const total = db.prepare(countSql).get(...params)?.total || 0;

  // 基本查询：LEFT JOIN face_cluster_meta，按 最近使用 > 有名字 > 图片数量 排序（只按 cluster_id 分组）
  const basicSql = `
    SELECT 
      fc.cluster_id,
      MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
      COUNT(DISTINCT m.id) AS mediaCount,
      MAX(COALESCE(fcm.last_used_at, 0)) AS sort_last_used
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_cluster_meta fcm ON fcm.user_id = fc.user_id AND fcm.cluster_id = fc.cluster_id
    WHERE ${whereClause}
    GROUP BY fc.cluster_id
    ORDER BY sort_last_used DESC, (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
    LIMIT ?
  `;
  params.push(Math.min(limit, 20));

  let basicRows;
  try {
    basicRows = db.prepare(basicSql).all(...params);
  } catch (err) {
    // face_cluster_meta 表可能不存在
    logger.warn({ message: "getRecentClustersByUserId 回退到默认排序", details: { userId, error: err.message } });
    const fallbackParams = params.slice(0, -1);
    const fallbackSql = `
      SELECT 
        fc.cluster_id,
        MAX(CASE WHEN fc.name IS NOT NULL AND length(trim(fc.name)) > 0 THEN trim(fc.name) END) AS name,
        COUNT(DISTINCT m.id) AS mediaCount
      FROM face_clusters fc
      INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
      INNER JOIN media m ON fe.media_id = m.id
      WHERE ${whereClause}
      GROUP BY fc.cluster_id
      ORDER BY (name IS NOT NULL AND name != '') DESC, mediaCount DESC, fc.cluster_id ASC
      LIMIT ?
    `;
    fallbackParams.push(Math.min(limit, 20));
    basicRows = db.prepare(fallbackSql).all(...fallbackParams);
  }

  if (basicRows.length === 0) {
    return { list: [], total };
  }

  const clusterIds = basicRows.map((row) => row.cluster_id);
  const coversMap = loadClusterCoverMap(userId, clusterIds);
  const timeMap = loadClusterTimeMap(userId, clusterIds);

  const list = basicRows.map((row) => ({
    clusterId: row.cluster_id,
    name: row.name || null,
    mediaCount: row.mediaCount,
    coverImage: coversMap.get(row.cluster_id) || null,
    timeRange: timeMap.get(row.cluster_id) || null,
  }));

  return { list, total };
}

/**
 * 获取当前用户下已存在的人物名称（用于重名校验）
 * @param {number|string} userId - 用户ID
 * @param {number|null} excludeClusterId - 排除的 cluster_id（修改名称时排除当前人物）
 * @returns {string[]} 已存在的名称数组（trim 后非空）
 */
function getExistingPersonNames(userId, excludeClusterId = null) {
  const sql = `
    SELECT cluster_id, TRIM(name) AS name
    FROM face_clusters
    WHERE user_id = ? AND name IS NOT NULL AND TRIM(name) != ''
    GROUP BY cluster_id
  `;
  const rows = db.prepare(sql).all(userId);
  return rows
    .filter((r) => excludeClusterId == null || r.cluster_id !== excludeClusterId)
    .map((r) => r.name);
}

/**
 * 获取尚未归属任何聚类的人脸 embedding（用于增量分配到已有 cluster）
 * @param {number|string} userId 用户 ID
 * @returns {Array<{ id: number, embedding: number[] }>}
 */
function getUnassignedFaceEmbeddingsByUserId(userId) {
  const sql = `
    SELECT fe.id, fe.embedding
    FROM media_face_embeddings fe
    INNER JOIN media m ON fe.media_id = m.id
    LEFT JOIN face_clusters fc ON fe.id = fc.face_embedding_id AND fc.user_id = ?
    WHERE m.user_id = ? AND m.deleted_at IS NULL AND fc.face_embedding_id IS NULL
    ORDER BY fe.id ASC
  `;
  const rows = db.prepare(sql).all(userId, userId);
  return rows.map((r) => ({
    id: r.id,
    embedding: JSON.parse(r.embedding.toString()),
  }));
}

/**
 * 获取指定 cluster 的所有 face_embedding_id 列表
 * @param {number|string} userId - 用户ID
 * @param {number|string} clusterId - 聚类ID
 * @returns {Array<number>} face_embedding_id 数组
 */
function getFaceEmbeddingIdsByClusterId(userId, clusterId) {
  const sql = `
    SELECT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND m.deleted_at IS NULL
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, clusterId);
  return rows.map((row) => row.face_embedding_id);
}

/**
 * 获取指定图片在该聚类下对应的人脸 face_embedding_id（每张图取一个，用于设置封面等）
 * @param {number|string} userId - 用户ID
 * @param {number|string} clusterId - 聚类ID
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表
 * @returns {Map<number, number>} mediaId -> faceEmbeddingId
 */
function getFaceEmbeddingIdByMediaIdInCluster(userId, clusterId, mediaIds) {
  const map = new Map();
  if (!mediaIds || mediaIds.length === 0) return map;

  const placeholders = mediaIds.map(() => "?").join(", ");
  const sql = `
    SELECT fe.media_id AS mediaId, MIN(fe.id) AS faceEmbeddingId
    FROM media_face_embeddings fe
    INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
    WHERE fc.user_id = ? AND fc.cluster_id = ? AND fe.media_id IN (${placeholders})
    GROUP BY fe.media_id
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId, clusterId, ...mediaIds);
  rows.forEach((row) => {
    map.set(row.mediaId, row.faceEmbeddingId);
  });
  return map;
}

/**
 * 获取聚类时生成的默认封面 face_embedding_id
 * 直接查找 representative_type = 1 的记录（默认封面）
 * @param {number|string} userId - 用户ID
 * @param {number|string} clusterId - 聚类ID
 * @returns {number|null} 默认封面的 face_embedding_id，如果找不到则返回 null
 */
function getDefaultCoverFaceEmbeddingId(userId, clusterId) {
  const sql = `
    SELECT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ? 
      AND fc.cluster_id = ?
      AND fc.representative_type = 1
      AND m.deleted_at IS NULL
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  const row = stmt.get(userId, clusterId);
  return row ? row.face_embedding_id : null;
}

/**
 * 获取用户当前作为封面的 face_embedding_id 列表（默认封面=1，手动封面=2）
 * @param {number|string} userId - 用户ID
 * @returns {number[]} face_embedding_id 列表
 */
function getRepresentativeFaceEmbeddingIdsByUserId(userId) {
  const sql = `
    SELECT DISTINCT fc.face_embedding_id
    FROM face_clusters fc
    INNER JOIN media_face_embeddings fe ON fc.face_embedding_id = fe.id
    INNER JOIN media m ON fe.media_id = m.id
    WHERE fc.user_id = ?
      AND fc.representative_type IN (1, 2)
      AND m.deleted_at IS NULL
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(userId);
  return rows.map((row) => row.face_embedding_id).filter((id) => id != null);
}

module.exports = {
  getFaceEmbeddingsByUserId,
  getClusterStatsByUserId,
  getClustersByUserId,
  getClusterCardByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  getUnassignedFaceEmbeddingsByUserId,
  getFaceEmbeddingIdsByClusterId,
  getFaceEmbeddingIdByMediaIdInCluster,
  getDefaultCoverFaceEmbeddingId,
  getRepresentativeFaceEmbeddingIdsByUserId
}
