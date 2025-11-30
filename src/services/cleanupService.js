const CustomError = require("../errors/customError");
const { ERROR_CODES } = require("../constants/messageCodes");
const { CLEANUP_TYPES, CLEANUP_TYPE_LIST } = require("../constants/cleanupTypes");
const cleanupModel = require("../models/cleanupModel");
const albumModel = require("../models/albumModel");
const cleanupEnqueueHelper = require("./cleanupEnqueueHelper");
const storageService = require("./storageService");
const imageService = require("./imageService");
const logger = require("../utils/logger");

function _normalizeType(type) {
  if (!type) return CLEANUP_TYPES.DUPLICATE;
  const lower = String(type).toLowerCase();
  return CLEANUP_TYPE_LIST.includes(lower) ? lower : CLEANUP_TYPES.DUPLICATE;
}

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

async function getCleanupSummary(userId) {
  const rows = cleanupModel.selectSummaryByUserId(userId);
  const summary = {
    duplicateGroupCount: 0,
    similarGroupCount: 0,
    blurryGroupCount: 0,
    duplicateCount: 0,
    similarCount: 0,
    blurryCount: 0,
  };

  rows.forEach((row) => {
    const type = row.group_type;
    const groupCount = row.group_count || 0;
    const memberCount = row.member_count || 0;

    switch (type) {
      case CLEANUP_TYPES.DUPLICATE:
        summary.duplicateGroupCount = groupCount;
        summary.duplicateCount = memberCount;
        break;
      case CLEANUP_TYPES.SIMILAR:
        summary.similarGroupCount = groupCount;
        summary.similarCount = memberCount;
        break;
      case CLEANUP_TYPES.BLURRY:
        summary.blurryGroupCount = groupCount;
        summary.blurryCount = memberCount;
        break;
      default:
        break;
    }
  });

  return summary;
}

async function getCleanupGroups({ userId, type, pageNo = 1, pageSize = 12 }) {
  const groupType = _normalizeType(type);

  // 模糊图类型特殊处理：按图片分页（每页20张），而不是按组分页
  if (groupType === CLEANUP_TYPES.BLURRY) {
    return await _getBlurryGroups({ userId, pageNo, pageSize: 20 });
  }

  // 其他类型（duplicate/similar）：按组分页（每页12组）
  const safePageSize = Math.max(Number(pageSize) || 12, 1);
  const safePageNo = Math.max(Number(pageNo) || 1, 1);
  const offset = (safePageNo - 1) * safePageSize;

  const totalCount = cleanupModel.countGroupsByType({ userId, groupType });
  if (totalCount === 0) {
    return { list: [], hasMore: false, nextCursor: null, total: 0 };
  }

  const rawGroups = cleanupModel.selectGroupsByType({
    userId,
    groupType,
    limit: safePageSize,
    offset,
  });

  if (!rawGroups.length) {
    return { list: [], hasMore: false, nextCursor: null, total: totalCount };
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
      const target = members?.find((item) => item.imageId === row.image_id);
      if (!target) return;

      // 补齐缩略图 URL
      if (row.thumbnail_storage_key) {
        try {
          const url = await storageService.getFileUrl(row.thumbnail_storage_key, row.storage_type);
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
          const url = await storageService.getFileUrl(row.high_res_storage_key, row.storage_type);
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

      // 对于相似图和重复图，如果只有1张图片，过滤掉这个分组
      if ((groupType === CLEANUP_TYPES.SIMILAR || groupType === CLEANUP_TYPES.DUPLICATE) && members.length <= 1) {
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

  const hasMore = offset + rawGroups.length < totalCount;
  const nextCursor = hasMore ? `${groupType}:${safePageNo + 1}` : null;

  return {
    list: groups,
    total: totalCount,
  };
}

/**
 * 获取模糊图分组（按图片分页）
 * 模糊图只有一个组，但需要按图片分页，每页20张
 */
async function _getBlurryGroups({ userId, pageNo = 1, pageSize = 20 }) {
  const safePageSize = Math.max(Number(pageSize) || 20, 1);
  const safePageNo = Math.max(Number(pageNo) || 1, 1);
  const offset = (safePageNo - 1) * safePageSize;

  // 查询模糊图分组（应该只有一个）
  const rawGroups = cleanupModel.selectGroupsByType({
    userId,
    groupType: CLEANUP_TYPES.BLURRY,
    limit: 1,
    offset: 0,
  });

  if (!rawGroups.length) {
    return { list: [], hasMore: false, nextCursor: null, total: 0 };
  }

  const group = rawGroups[0];

  // 统计该组的成员总数
  const totalCount = cleanupModel.countMembersByGroupId(group.id);
  if (totalCount === 0) {
    return { list: [], hasMore: false, nextCursor: null, total: 0 };
  }

  // 查询当前页的成员
  const rawMembers = cleanupModel.selectMembersByGroupIdPaginated(group.id, safePageSize, offset);
  if (!rawMembers.length) {
    return { list: [], hasMore: false, nextCursor: null, total: totalCount };
  }

  // 映射成员数据
  const members = rawMembers.map((row) => _mapMemberRow(row));

  // 批量补齐缩略图和高清图 URL（isFavorite字段已从数据库直接返回）
  await Promise.all(
    rawMembers.map(async (row, index) => {
      const target = members[index];
      if (!target) return;

      // 补齐缩略图 URL
      if (row.thumbnail_storage_key) {
        try {
          const url = await storageService.getFileUrl(row.thumbnail_storage_key, row.storage_type);
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
          const url = await storageService.getFileUrl(row.high_res_storage_key, row.storage_type);
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

  // 模糊图只需要基本字段：imageId, thumbnailUrl, highResUrl
  // 移除 rankScore, similarity 等不需要的字段
  const blurryMembers = members.map((member) => ({
    imageId: member.imageId,
    thumbnailUrl: member.thumbnailUrl,
    highResUrl: member.highResUrl,
  }));

  const hasMore = offset + blurryMembers.length < totalCount;
  const nextCursor = hasMore ? `${CLEANUP_TYPES.BLURRY}:${safePageNo + 1}` : null;

  return {
    list: [
      {
        id: group.id,
        groupType: group.group_type, // 前端需要通过 groupType 来查找模糊图分组
        updatedAt: _formatTimestamp(group.updated_at), // 添加更新时间字段，用于前端显示
        members: blurryMembers, // 当前页的成员数据（只包含必要字段）
      },
    ],
    total: totalCount, // 返回成员总数，与相似图/重复图的 total 含义保持一致（成员总数）
  };
}

// 删除图片（软删除，移至回收站）
// groupId: 可选，如果提供则从分组中获取类型（duplicate/similar/blurry），如果不提供则视为 'all' 类型
// 这个方法在核心删除逻辑基础上，增加了清理分组相关的处理
async function deleteImages({ userId, groupId, imageIds }) {
  const normalizedIds = _normalizeIdList(imageIds);

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: "warning",
    });
  }

  // 从 groupId 获取分组信息和类型
  let type = "all"; // 默认类型
  let group = null;

  if (groupId) {
    const numericGroupId = Number(groupId);
    if (!Number.isFinite(numericGroupId)) {
      throw new CustomError({
        httpStatus: 400,
        messageCode: ERROR_CODES.INVALID_PARAMETERS,
        messageType: "warning",
      });
    }

    group = cleanupModel.selectGroupById(numericGroupId);
    if (!group || group.user_id !== userId) {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: "warning",
      });
    }

    // 从分组中获取类型
    type = group.group_type || "all";
  }

  // 调用 imageService 的核心删除方法
  await imageService.deleteImages({ userId, imageIds: normalizedIds });

  // 清理分组相关的处理
  // 从所有包含这些图片的分组中移除成员记录
  cleanupModel.deleteGroupMembersByImageIds(normalizedIds);

  // 更新所有相关分组的统计（member_count、primary_image_id、total_size_bytes）
  cleanupModel.refreshGroupsStatsForImages(normalizedIds);

  logger.info({
    message: "cleanup.delete.completed",
    details: {
      userId,
      type,
      groupId: group?.id || null,
      imageIds: normalizedIds,
    },
  });

  // 如果指定了分组，检查该分组是否还存在（可能已被删除）
  if (group) {
    const refreshResult = cleanupModel.refreshGroupStats(group.id, { updatedAt: Date.now() });
    return {
      resolved: refreshResult.deleted || refreshResult.memberCount === 0,
    };
  }

  return {
    resolved: true,
  };
}

function _mapMemberRow(row) {
  return {
    imageId: row.image_id,
    rankScore: row.rank_score,
    similarity: row.similarity,
    thumbnailUrl: null,
    highResUrl: null,
    isFavorite: row.is_favorite === 1 || row.is_favorite === true,
  };
}

module.exports = {
  getCleanupSummary,
  getCleanupGroups,
  deleteImages,
};
