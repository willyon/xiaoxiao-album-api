const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const { CLEANUP_TYPES } = require("../constants/cleanupTypes");
const cleanupModel = require("../models/cleanupModel");
const mediaService = require("./mediaService");
const storageService = require("./storageService");
const logger = require("../utils/logger");

function _formatTimestamp(value) {
  if (!value && value !== 0) return null;
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString();
  }
  try {
    return new Date(value).toISOString();
  } catch (error) {
    return null;
  }
}

function _normalizeIdList(ids) {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    })
    .filter((value) => value !== null);
}

/**
 * 获取相似图分组列表（清理页相似图 tab，模糊图请使用 GET /api/images/blurry）
 */
async function getSimilarGroups({ userId, pageNo = 1, pageSize = 12 }) {
  const groupType = CLEANUP_TYPES.SIMILAR;

  const safePageSize = Math.max(Number(pageSize) || 12, 1);
  const safePageNo = Math.max(Number(pageNo) || 1, 1);
  const offset = (safePageNo - 1) * safePageSize;

  // 相似图只统计/分页「可展示」分组（至少 2 个未删除成员），避免 total 与 list 不一致
  const totalCount = cleanupModel.countDisplayableSimilarGroups(userId);
  if (totalCount === 0) {
    return { list: [], total: 0 };
  }

  const rawGroups = cleanupModel.selectDisplayableSimilarGroups({
    userId,
    limit: safePageSize,
    offset,
  });

  if (!rawGroups.length) {
    return { list: [], total: totalCount };
  }

  const groupIds = rawGroups.map((group) => group.id);
  const rawMembers = cleanupModel.selectMembersByGroupIds(groupIds);
  const membersByGroup = new Map();
  for (const memberRow of rawMembers) {
    if (!membersByGroup.has(memberRow.group_id)) {
      membersByGroup.set(memberRow.group_id, []);
    }
    membersByGroup.get(memberRow.group_id).push(_mapMemberRow(memberRow));
  }

  // 批量补齐缩略图和高清图 URL（isFavorite字段已从数据库直接返回）
  await Promise.all(
    rawMembers.map(async (row) => {
      const members = membersByGroup.get(row.group_id);
      const target = members?.find((item) => item.mediaId === row.media_id);
      if (!target) return;

      // 补齐缩略图 URL
      if (row.thumbnail_storage_key) {
        try {
          const url = await storageService.getFileUrl(row.thumbnail_storage_key);
          target.thumbnailUrl = url;
        } catch (error) {
          logger.warn({
            message: "获取缩略图 URL 失败",
            details: { storageKey: row.thumbnail_storage_key, error: error.message },
          });
        }
      }

      // 补齐高清图 URL
      if (row.high_res_storage_key) {
        try {
          const url = await storageService.getFileUrl(row.high_res_storage_key);
          target.highResUrl = url;
        } catch (error) {
          logger.warn({
            message: "获取高清图 URL 失败",
            details: { storageKey: row.high_res_storage_key, error: error.message },
          });
        }
      }

      // isFavorite字段已从数据库直接返回，通过 _mapMemberRow 映射
      // 如果 target 中没有 isFavorite，从 row 中读取
      if (target.isFavorite === undefined) {
        target.isFavorite = row.is_favorite === 1 || row.is_favorite === true;
      }
    }),
  );

  const groups = rawGroups
    .map((group) => {
      const members = membersByGroup.get(group.id) || [];

      // 对于相似图，如果只有1张图片，过滤掉这个分组
      if (groupType === CLEANUP_TYPES.SIMILAR && members.length <= 1) {
        return null;
      }

      // 后端已经按照 rankScore 和 image_created_at 排序好了，并且第一个就是推荐图片
      // 前端直接使用后端返回的顺序，第一个成员就是推荐图片
      return {
        id: group.id,
        groupType: group.group_type,
        updatedAt: _formatTimestamp(group.updated_at),
        members,
      };
    })
    .filter((group) => group !== null); // 过滤掉 null（只有1张图片的分组）

  return {
    list: groups,
    total: totalCount,
  };
}

// 删除图片（软删除，移至回收站）
// 仅相似图删除时调用，需传入 groupId，用于刷新该分组统计；模糊图/首页等删除直接走 imageService，不经过本方法
async function deleteMedias({ userId, groupId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  const numericGroupId = Number(groupId);
  if (!Number.isFinite(numericGroupId)) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  const group = cleanupModel.selectGroupById(numericGroupId);
  if (!group || group.user_id !== userId) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: "warning",
    });
  }

  await mediaService.deleteMedias({ userId, imageIds: normalizedIds });

  cleanupModel.deleteGroupMembersByImageIds(normalizedIds);
  cleanupModel.refreshGroupsStatsForMedias(normalizedIds);

  logger.info({
    message: "cleanup.delete.completed",
    details: {
      userId,
      groupId: group.id,
      imageIds: normalizedIds,
    },
  });

  const refreshResult = cleanupModel.refreshGroupStats(group.id, { updatedAt: Date.now() });
  return {
    resolved: refreshResult.deleted || refreshResult.memberCount === 0,
  };
}

function _mapMemberRow(row) {
  return {
    mediaId: row.media_id,
    groupId: row.group_id,
    rankScore: row.rank_score,
    similarity: row.similarity,
    thumbnailUrl: null, // 后续补齐URL
    highResUrl: null, // 后续补齐URL
    isFavorite: row.is_favorite === 1 || row.is_favorite === true,
    // PhotoPreview 和 PhotoInfoPanel 需要的字段
    capturedAt: row.captured_at,
    dayKey: row.day_key,
    gpsLocation: row.gps_location,
    widthPx: row.width_px,
    heightPx: row.height_px,
    aspectRatio: row.aspect_ratio,
    layoutType: row.layout_type,
    fileSizeBytes: row.file_size_bytes,
    faceCount: row.face_count,
    personCount: row.person_count,
    ageTags: row.age_tags,
    expressionTags: row.expression_tags,
    primaryFaceQuality: row.primary_face_quality,
    primaryExpressionConfidence: row.primary_expression_confidence,
  };
}

module.exports = {
  getSimilarGroups,
  deleteMedias,
};
