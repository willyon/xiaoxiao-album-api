const { db } = require("../services/database");

function selectMediaForCleanup(imageId) {
  const stmt = db.prepare(`
    SELECT
      m.id,
      m.user_id,
      m.file_hash AS image_hash,
      m.phash AS image_phash,
      m.dhash AS image_dhash,
      m.high_res_storage_key,
      m.original_storage_key,
      m.thumbnail_storage_key,
      m.file_size_bytes,
      m.aesthetic_score,
      m.sharpness_score
    FROM media m
    WHERE m.id = ?
    LIMIT 1
  `);
  return stmt.get(imageId);
}

function selectCleanupCandidatesByUser(userId) {
  const stmt = db.prepare(`
    SELECT
      m.id,
      m.user_id,
      m.file_size_bytes,
      m.file_hash AS image_hash,
      m.phash AS image_phash,
      m.dhash AS image_dhash,
      m.aesthetic_score,
      m.sharpness_score,
      m.captured_at AS image_created_at
    FROM media m
    WHERE m.user_id = ?
      AND (m.deleted_at IS NULL)
  `);
  return stmt.all(userId);
}

/**
 * 查询用户未分析的图片（用于清理分析入队）
 * 只返回未分析的图片：image_phash、aesthetic_score、sharpness_score 任一为 NULL
 */
function selectUnanalyzedMediasByUser(userId) {
  const stmt = db.prepare(`
    SELECT
      m.id,
      m.user_id,
      m.created_at,
      m.high_res_storage_key,
      m.original_storage_key,
      m.phash AS image_phash,
      m.dhash AS image_dhash,
      m.aesthetic_score,
      m.sharpness_score
    FROM media m
    WHERE m.user_id = ?
      AND (m.high_res_storage_key IS NOT NULL OR m.original_storage_key IS NOT NULL)
      AND (m.deleted_at IS NULL)
      AND (
        m.phash IS NULL
        OR m.aesthetic_score IS NULL
        OR m.sharpness_score IS NULL
      )
    ORDER BY m.created_at DESC
  `);
  return stmt.all(userId);
}

function updateMediaCleanupMetrics(imageId, { imagePhash, imageDhash, aestheticScore, sharpnessScore }) {
  return db
    .prepare(
      `
      UPDATE media
      SET
        phash = ?,
        dhash = ?,
        aesthetic_score = ?,
        sharpness_score = ?
      WHERE id = ?
    `,
    )
    .run(imagePhash ?? null, imageDhash ?? null, aestheticScore ?? null, sharpnessScore ?? null, imageId);
}

function deleteGroupsByUser(userId) {
  const stmt = db.prepare(`
    DELETE FROM similar_groups
    WHERE user_id = ?
  `);
  stmt.run(userId);
}

function insertSimilarGroup({ userId, primaryImageId, memberCount, createdAt, updatedAt }) {
  const stmt = db.prepare(`
    INSERT INTO similar_groups (
      user_id,
      primary_media_id,
      member_count,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  const result = stmt.run(userId, primaryImageId ?? null, memberCount ?? 0, createdAt ?? now, updatedAt ?? now);
  return result.lastInsertRowid;
}

function insertSimilarGroupMember(groupId, { imageId, rankScore, similarity, aestheticScore }) {
  const stmt = db.prepare(`
    INSERT INTO similar_group_members (
      group_id,
      media_id,
      rank_score,
      similarity,
      aesthetic_score,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  stmt.run(groupId, imageId, rankScore ?? null, similarity ?? null, aestheticScore ?? null, now, now);
}

/**
 * 查询指定类型的清理分组
 */
function selectGroupsByType({ userId, limit, offset }) {
  const stmt = db.prepare(`
    SELECT
      id,
      user_id,
      primary_media_id,
      member_count,
      created_at,
      updated_at
    FROM similar_groups
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(userId, limit, offset);
}

function countGroupsByType({ userId }) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM similar_groups
    WHERE user_id = ?
  `);
  const result = stmt.get(userId);
  return result?.total || 0;
}

/**
 * 统计「可展示」的相似图分组数量：至少有 2 个未删除成员的分组（与列表过滤逻辑一致，避免 total 与 list 不一致）
 */
function countDisplayableSimilarGroups(userId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM similar_groups sg
    WHERE sg.user_id = ?
      AND (
        SELECT COUNT(*)
        FROM similar_group_members cgm
        JOIN media i ON i.id = cgm.media_id
        WHERE cgm.group_id = sg.id AND i.deleted_at IS NULL
      ) >= 2
  `);
  const result = stmt.get(userId);
  return result?.total || 0;
}

/**
 * 分页查询「可展示」的相似图分组：至少有 2 个未删除成员，排序与 selectGroupsByType 一致
 */
function selectDisplayableSimilarGroups({ userId, limit, offset }) {
  const stmt = db.prepare(`
    SELECT
      sg.id,
      sg.user_id,
      sg.primary_media_id,
      sg.member_count,
      sg.created_at,
      sg.updated_at
    FROM similar_groups sg
    WHERE sg.user_id = ?
      AND (
        SELECT COUNT(*)
        FROM similar_group_members cgm
        JOIN media i ON i.id = cgm.media_id
        WHERE cgm.group_id = sg.id AND i.deleted_at IS NULL
      ) >= 2
    ORDER BY sg.updated_at DESC, sg.id DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(userId, limit, offset);
}

/**
 * 查询分组成员及关联的图片信息
 * 过滤已删除的图片（deleted_at IS NULL）
 */
function selectMembersByGroupIds(groupIds) {
  if (!groupIds || groupIds.length === 0) return [];

  const placeholders = groupIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT
      cgm.group_id,
      cgm.media_id,
      cgm.rank_score,
      cgm.similarity,
      cgm.aesthetic_score,
      cgm.created_at,
      cgm.updated_at,
      i.user_id,
      i.thumbnail_storage_key,
      i.high_res_storage_key,
      i.file_size_bytes,
      i.aesthetic_score AS image_aesthetic_score,
      i.captured_at,
      i.is_favorite,
      i.date_key,
      i.day_key,
      i.gps_location,
      i.width_px,
      i.height_px,
      i.aspect_ratio,
      i.layout_type,
      COALESCE(i.face_count, 0) AS face_count,
      COALESCE(i.person_count, 0) AS person_count,
      NULL AS age_tags,
      i.expression_tags AS expression_tags,
      NULL AS has_young,
      NULL AS has_adult
    FROM similar_group_members cgm
    JOIN media i ON i.id = cgm.media_id
    WHERE cgm.group_id IN (${placeholders})
      AND i.deleted_at IS NULL
    ORDER BY cgm.group_id, cgm.rank_score DESC, i.captured_at DESC, cgm.media_id
  `);

  return stmt.all(...groupIds);
}

/**
 * 统计指定分组的成员数量（未删除的）
 * @param {number} groupId - 分组ID
 * @returns {number}
 */
function countMembersByGroupId(groupId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM similar_group_members cgm
    JOIN media i ON i.id = cgm.media_id
    WHERE cgm.group_id = ?
      AND i.deleted_at IS NULL
  `);
  const result = stmt.get(groupId);
  return result?.total || 0;
}

/**
 * 删除分组成员
 */
function deleteGroupMembers(groupId, mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return { changes: 0 };
  const placeholders = mediaIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    DELETE FROM similar_group_members
    WHERE group_id = ?
      AND media_id IN (${placeholders})
  `);
  return stmt.run(groupId, ...mediaIds);
}

/**
 * 删除整个分组
 */
function deleteGroup(groupId) {
  const stmt = db.prepare(`DELETE FROM similar_groups WHERE id = ?`);
  return stmt.run(groupId);
}

/**
 * 更新分组统计信息
 * member_count 统计所有未删除的成员（包含推荐图片）
 */
function refreshGroupStats(groupId, { updatedAt }) {
  // 统计所有未删除的成员（包含推荐图片）
  const statsStmt = db.prepare(`
    SELECT
      COUNT(*) AS member_count
    FROM similar_group_members cgm
    JOIN media i ON i.id = cgm.media_id
    WHERE cgm.group_id = ?
      AND i.deleted_at IS NULL
  `);
  const stats = statsStmt.get(groupId);

  if (!stats || stats.member_count === 0) {
    deleteGroup(groupId);
    return { deleted: true };
  }

  // 相似图分组如果只剩 1 张图片，不满足展示条件，直接删除分组
  if (stats.member_count <= 1) {
    deleteGroup(groupId);
    return { deleted: true };
  }

  // 选择 primary_media_id：选择 rank_score 最高的
  const primaryStmt = db.prepare(`
    SELECT cgm.media_id
    FROM similar_group_members cgm
    JOIN media i ON i.id = cgm.media_id
    WHERE cgm.group_id = ?
      AND i.deleted_at IS NULL
    ORDER BY cgm.rank_score DESC, cgm.media_id
    LIMIT 1
  `);
  const primary = primaryStmt.get(groupId);

  const updateStmt = db.prepare(`
    UPDATE similar_groups
    SET
      member_count = ?,
      primary_media_id = ?,
      updated_at = ?
    WHERE id = ?
  `);
  updateStmt.run(stats.member_count || 0, primary?.media_id || null, updatedAt, groupId);
  return { deleted: false, memberCount: stats.member_count || 0 };
}

/**
 * 查询指定分组信息
 */
function selectGroupById(groupId) {
  const stmt = db.prepare(`
    SELECT *
    FROM similar_groups
    WHERE id = ?
  `);
  return stmt.get(groupId);
}

/**
 * 查询图片的存储信息
 */
function selectMediasByIds(imageIds) {
  if (!imageIds || imageIds.length === 0) return [];
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    SELECT
      id,
      user_id,
      thumbnail_storage_key,
      high_res_storage_key,
      original_storage_key,
      file_size_bytes,
      file_hash AS image_hash
    FROM media
    WHERE id IN (${placeholders})
      AND deleted_at IS NULL
  `);
  return stmt.all(...imageIds);
}

/**
 * 从 images 表删除指定图片
 */
function deleteMediasByIds(imageIds) {
  if (!imageIds || imageIds.length === 0) return { changes: 0 };
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    DELETE FROM media
    WHERE id IN (${placeholders})
  `);
  return stmt.run(...imageIds);
}

function markMediasDeleted(imageIds = [], deletedAt) {
  if (!imageIds || imageIds.length === 0) return { changes: 0 };
  const placeholders = imageIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    UPDATE media
    SET deleted_at = ?
    WHERE id IN (${placeholders})
  `);
  return stmt.run(deletedAt, ...imageIds);
}

function deleteGroupMembersByImageIds(mediaIds = []) {
  if (!mediaIds || mediaIds.length === 0) return { changes: 0 };
  const placeholders = mediaIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    DELETE FROM similar_group_members
    WHERE media_id IN (${placeholders})
  `);
  return stmt.run(...mediaIds);
}

/**
 * 获取包含指定图片的所有分组ID
 */
function getGroupsContainingMedias(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return [];

  const placeholders = mediaIds.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT cgm.group_id
    FROM similar_group_members cgm
    WHERE cgm.media_id IN (${placeholders})
  `;

  const stmt = db.prepare(sql);
  const results = stmt.all(...mediaIds);
  return results.map((row) => row.group_id);
}

/**
 * 批量更新包含指定图片的所有分组统计
 */
function refreshGroupsStatsForMedias(imageIds) {
  if (!imageIds || imageIds.length === 0) return;

  // 获取包含这些图片的所有分组ID
  const groupIds = getGroupsContainingMedias(imageIds);
  if (groupIds.length === 0) return;

  const now = Date.now();

  // 批量更新每个分组的统计信息
  groupIds.forEach((groupId) => {
    try {
      refreshGroupStats(groupId, { updatedAt: now });
    } catch (error) {
      // 如果分组已被删除（refreshGroupStats 会删除空分组），忽略错误
      console.error(`更新分组 ${groupId} 统计失败:`, error.message);
    }
  });
}

module.exports = {
  selectGroupsByType,
  selectMembersByGroupIds,
  countMembersByGroupId,
  selectGroupById,
  deleteGroupMembers,
  deleteGroup,
  refreshGroupStats,
  selectMediasByIds,
  deleteMediasByIds,
  markMediasDeleted,
  deleteGroupMembersByImageIds,
  getGroupsContainingMedias,
  refreshGroupsStatsForMedias,
  countGroupsByType,
  countDisplayableSimilarGroups,
  selectDisplayableSimilarGroups,
  selectMediaForCleanup,
  selectCleanupCandidatesByUser,
  selectUnanalyzedMediasByUser,
  updateMediaCleanupMetrics,
  deleteGroupsByUser,
  insertSimilarGroup,
  insertSimilarGroupMember,
};
