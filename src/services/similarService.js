const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const cleanupModel = require('../models/cleanupModel')
const mediaService = require('./mediaService')
const logger = require('../utils/logger')
const { normalizeNumericIds } = require('../utils/normalizeNumericIds')
const { hydrateMediaUrls } = require('../utils/mediaUrlHydrator')

/**
 * 统一格式化时间戳为 ISO 字符串。
 * @param {string|number|Date|null|undefined} value - 原始时间值。
 * @returns {string|null} ISO 字符串或 null。
 */
function _formatTimestamp(value) {
  if (!value && value !== 0) return null
  if (typeof value === 'number') {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString()
  }
  try {
    return new Date(value).toISOString()
  } catch {
    return null
  }
}

/**
 * 获取相似图分组列表（清理页相似图 tab，模糊图请使用 GET /api/images/blurry）
 * @param {{userId:number|string,pageNo?:number,pageSize?:number}} params - 查询参数。
 * @returns {Promise<{list:Array<{id:number,updatedAt:string|null,members:Array<object>}>,total:number}>} 分组列表与总数。
 */
async function getSimilarGroups({ userId, pageNo = 1, pageSize = 12 }) {
  const safePageSize = Math.max(Number(pageSize) || 12, 1)
  const safePageNo = Math.max(Number(pageNo) || 1, 1)
  const offset = (safePageNo - 1) * safePageSize

  // 相似图只统计/分页「可展示」分组（至少 2 个未删除成员），避免 total 与 list 不一致
  const totalCount = cleanupModel.countDisplayableSimilarGroups(userId)
  if (totalCount === 0) {
    return { list: [], total: 0 }
  }

  const rawGroups = cleanupModel.selectDisplayableSimilarGroups({
    userId,
    limit: safePageSize,
    offset
  })

  if (!rawGroups.length) {
    return { list: [], total: totalCount }
  }

  const groupIds = rawGroups.map((group) => group.id)
  const rawMembers = cleanupModel.selectMembersByGroupIds(groupIds)
  const membersByGroup = new Map()
  for (const memberRow of rawMembers) {
    if (!membersByGroup.has(memberRow.group_id)) {
      membersByGroup.set(memberRow.group_id, [])
    }
    membersByGroup.get(memberRow.group_id).push(_mapMemberRow(memberRow))
  }

  // 批量补齐缩略图和高清图 URL（isFavorite 字段已由 _mapMemberRow 映射）
  const membersToHydrate = []
  for (const [groupId, members] of membersByGroup.entries()) {
    members.forEach((member, index) => {
      membersToHydrate.push({ ...member, _groupId: groupId, _index: index })
    })
  }
  const hydratedMembers = await hydrateMediaUrls(membersToHydrate, {
    thumbnailKey: 'thumbnailStorageKey',
    highResKey: 'highResStorageKey',
    originalKey: 'originalStorageKey',
    dropStorageKeys: true
  })
  hydratedMembers.forEach((member) => {
    const targetList = membersByGroup.get(member._groupId)
    if (!targetList) return
    targetList[member._index] = {
      ...targetList[member._index],
      thumbnailUrl: member.thumbnailUrl,
      highResUrl: member.highResUrl
    }
  })

  const groups = rawGroups
    .map((group) => {
      const members = membersByGroup.get(group.id) || []

      // 对于相似图，如果只有1张图片，过滤掉这个分组
      if (members.length <= 1) {
        return null
      }

      // 后端已经按照 rankScore 和 image_created_at 排序好了，并且第一个就是推荐图片
      // 前端直接使用后端返回的顺序，第一个成员就是推荐图片
      return {
        id: group.id,
        updatedAt: _formatTimestamp(group.updated_at),
        members: members.map(({ thumbnailStorageKey: _thumbnailStorageKey, highResStorageKey: _highResStorageKey, ...member }) => member)
      }
    })
    .filter((group) => group !== null) // 过滤掉 null（只有1张图片的分组）

  return {
    list: groups,
    total: totalCount
  }
}

// 删除图片（软删除，移至回收站）
// 仅相似图删除时调用，需传入 groupId，用于刷新该分组统计；模糊图/首页等删除直接走 imageService，不经过本方法
/**
 * 删除相似图分组中的媒体并刷新分组状态。
 * @param {{userId:number|string,groupId:number|string,mediaIds:Array<string|number>}} params - 删除参数。
 * @returns {Promise<{resolved:boolean}>} 分组是否已被清空。
 */
async function deleteMedias({ userId, groupId, mediaIds }) {
  const normalizedIds = normalizeNumericIds(mediaIds)

  if (normalizedIds.length === 0) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }

  const numericGroupId = Number(groupId)
  if (!Number.isFinite(numericGroupId)) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.INVALID_PARAMETERS,
      messageType: 'warning'
    })
  }

  const group = cleanupModel.selectGroupById(numericGroupId)
  if (!group || group.user_id !== userId) {
    throw new CustomError({
      httpStatus: 404,
      messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
      messageType: 'warning'
    })
  }

  await mediaService.deleteMedias({ userId, mediaIds: normalizedIds })

  cleanupModel.deleteGroupMembersByMediaIds(normalizedIds)
  cleanupModel.refreshGroupsStatsForMedias(normalizedIds)

  logger.info({
    message: 'cleanup.delete.completed',
    details: {
      userId,
      groupId: group.id,
      mediaIds: normalizedIds
    }
  })

  const refreshResult = cleanupModel.refreshGroupStats(group.id, { updatedAt: Date.now() })
  return {
    resolved: refreshResult.deleted || refreshResult.memberCount === 0
  }
}

/**
 * 将清理分组成员行映射为前端结构。
 * @param {Record<string, any>} row - 数据库成员行。
 * @returns {object} 映射后的成员对象。
 */
function _mapMemberRow(row) {
  return {
    mediaId: row.media_id,
    groupId: row.group_id,
    rankScore: row.rank_score,
    similarity: row.similarity,
    thumbnailStorageKey: row.thumbnail_storage_key || null,
    highResStorageKey: row.high_res_storage_key || null,
    thumbnailUrl: null, // 后续补齐URL
    highResUrl: null, // 后续补齐URL
    isFavorite: row.is_favorite === 1 || row.is_favorite === true,
    // PhotoPreview 和 PhotoInfoPanel 需要的字段
    capturedAt: row.captured_at,
    dateKey: row.date_key,
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
    expressionTags: row.expression_tags
  }
}

module.exports = {
  getSimilarGroups,
  deleteMedias
}
