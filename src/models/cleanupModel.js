const { db } = require("../db");

/**
 * 查询用户可参与清理分组的媒体候选。
 * @param {number|string} userId - 用户 ID。
 * @returns {Array<object>} 候选媒体列表。
 */
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
 * 删除用户所有相似图分组。
 * @param {number|string} userId - 用户 ID。
 * @returns {void} 无返回值。
 */
function deleteGroupsByUser(userId) {
  const stmt = db.prepare(`
    DELETE FROM similar_groups
    WHERE user_id = ?
  `);
  stmt.run(userId);
}

/**
 * 新建相似图分组。
 * @param {{userId:number|string,primaryMediaId?:number|null,memberCount?:number,createdAt?:number,updatedAt?:number}} params - 分组参数。
 * @returns {number|bigint} 新分组 ID。
 */
function insertSimilarGroup({ userId, primaryMediaId, memberCount, createdAt, updatedAt }) {
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
  const result = stmt.run(userId, primaryMediaId ?? null, memberCount ?? 0, createdAt ?? now, updatedAt ?? now);
  return result.lastInsertRowid;
}

/**
 * 添加相似图分组成员。
 * @param {number|string} groupId - 分组 ID。
 * @param {{mediaId:number,rankScore?:number,similarity?:number,aestheticScore?:number}} member - 成员数据。
 * @returns {void} 无返回值。
 */
function insertSimilarGroupMember(groupId, { mediaId, rankScore, similarity, aestheticScore }) {
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
  stmt.run(groupId, mediaId, rankScore ?? null, similarity ?? null, aestheticScore ?? null, now, now);
}

/**
 * 事务化替换用户相似图分组：先删旧分组，再写入新分组及成员。
 * @param {{userId:number|string,groups:Array<{primaryMediaId:number,members:Array<{mediaId:number,rankScore?:number,similarity?:number,aestheticScore?:number}>}>}} params
 * @returns {{groupCount:number}} 创建分组数量。
 */
function replaceGroupsByUser({ userId, groups }) {
  const runInTransaction = db.transaction((targetUserId, targetGroups) => {
    deleteGroupsByUser(targetUserId);
    if (!targetGroups || targetGroups.length === 0) {
      return { groupCount: 0 };
    }

    const now = Date.now();
    let createdGroups = 0;
    for (const group of targetGroups) {
      const groupId = insertSimilarGroup({
        userId: targetUserId,
        primaryMediaId: group.primaryMediaId,
        memberCount: group.members.length,
        updatedAt: now,
      });
      createdGroups += 1;
      for (const member of group.members) {
        insertSimilarGroupMember(groupId, member);
      }
    }
    return { groupCount: createdGroups };
  });

  return runInTransaction(userId, groups);
}

/**
 * 统计「可展示」的相似图分组数量：至少有 2 个未删除成员的分组（与列表过滤逻辑一致，避免 total 与 list 不一致）
 * @param {number|string} userId - 用户 ID。
 * @returns {number} 可展示分组数量。
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
 * 分页查询「可展示」的相似图分组：至少有 2 个未删除成员，按 updated_at、id 倒序
 * @param {{userId:number|string,limit:number,offset:number}} params - 查询参数。
 * @returns {Array<object>} 分组列表。
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
 * @param {Array<number|string>} groupIds - 分组 ID 列表。
 * @returns {Array<object>} 成员列表。
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
 * 删除整个分组
 * @param {number|string} groupId - 分组 ID。
 * @returns {import('better-sqlite3').RunResult} 执行结果。
 */
function deleteGroup(groupId) {
  const stmt = db.prepare(`DELETE FROM similar_groups WHERE id = ?`);
  return stmt.run(groupId);
}

/**
 * 更新分组统计信息
 * member_count 统计所有未删除的成员（包含推荐图片）
 * @param {number|string} groupId - 分组 ID。
 * @param {{updatedAt:number}} params - 更新时间参数。
 * @returns {{deleted:true}|{deleted:false,memberCount:number}} 更新结果。
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
 * @param {number|string} groupId - 分组 ID。
 * @returns {object|undefined} 分组信息。
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
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {Array<object>} 媒体信息列表。
 */
function selectMediasByIds(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return [];
  const placeholders = mediaIds.map(() => "?").join(", ");
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
  return stmt.all(...mediaIds);
}

/**
 * 批量软删除媒体。
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @param {number} deletedAt - 删除时间戳。
 * @returns {{changes:number}} 影响行数。
 */
function markMediasDeleted(mediaIds = [], deletedAt) {
  if (!mediaIds || mediaIds.length === 0) return { changes: 0 };
  const placeholders = mediaIds.map(() => "?").join(", ");
  const stmt = db.prepare(`
    UPDATE media
    SET deleted_at = ?
    WHERE id IN (${placeholders})
  `);
  return stmt.run(deletedAt, ...mediaIds);
}

/**
 * 按媒体 ID 批量删除分组成员关系。
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {{changes:number}} 影响行数。
 */
function deleteGroupMembersByMediaIds(mediaIds = []) {
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
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {number[]} 分组 ID 列表。
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
 * @param {Array<number|string>} mediaIds - 媒体 ID 列表。
 * @returns {void} 无返回值。
 */
function refreshGroupsStatsForMedias(mediaIds) {
  if (!mediaIds || mediaIds.length === 0) return;

  // 获取包含这些图片的所有分组ID
  const groupIds = getGroupsContainingMedias(mediaIds);
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
  selectMembersByGroupIds,
  selectGroupById,
  refreshGroupStats,
  selectMediasByIds,
  markMediasDeleted,
  deleteGroupMembersByMediaIds,
  getGroupsContainingMedias,
  refreshGroupsStatsForMedias,
  countDisplayableSimilarGroups,
  selectDisplayableSimilarGroups,
  selectCleanupCandidatesByUser,
  deleteGroupsByUser,
  insertSimilarGroup,
  insertSimilarGroupMember,
  replaceGroupsByUser,
};
