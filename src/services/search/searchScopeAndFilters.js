/**
 * 搜索 scope 与筛选组装层：负责将上层请求参数转换为可复用的 SQL WHERE 条件与参数。
 */
const mediaModel = require('../../models/mediaModel')
const { buildSearchQueryParts } = require('../../utils/buildSearchQueryParts')

/**
 * 根据 source + scope 构建列表/筛选用的 WHERE 片段（表别名 i.），供搜索与筛选项 scope 共用。
 * @param {{source?:string,type?:string,albumId?:string|number,clusterId?:string|number}} scope - scope 条件。
 * @param {number|string} userId - 用户 ID。
 * @returns {{ scopeConditions: string[], scopeParams: any[] }} scope 条件与参数。
 */
function buildScopeConditions(scope, userId) {
  const scopeConditions = []
  const scopeParams = []
  if (!scope || !scope.source) return { scopeConditions, scopeParams }

  const { source, type, albumId, clusterId } = scope

  switch (source) {
    case 'favorites':
      scopeConditions.push('i.is_favorite = 1')
      break
    case 'timeline':
      if (type === 'year' && albumId != null) {
        scopeConditions.push('i.year_key = ?')
        scopeParams.push(String(albumId))
      } else if (type === 'month' && albumId != null) {
        scopeConditions.push('i.month_key = ?')
        scopeParams.push(String(albumId))
      } else if (type === 'day' && albumId != null) {
        scopeConditions.push('i.date_key = ?')
        scopeParams.push(String(albumId))
      } else if (type === 'unknown') {
        scopeConditions.push("(i.year_key = 'unknown' AND i.month_key = 'unknown' AND i.date_key = 'unknown' AND i.day_key = 'unknown')")
      }
      break
    case 'album':
      if (albumId != null && albumId !== '') {
        const aid = parseInt(albumId, 10)
        if (!Number.isNaN(aid)) {
          scopeConditions.push('i.id IN (SELECT media_id FROM album_media WHERE album_id = ?)')
          scopeParams.push(aid)
        }
      }
      break
    case 'location':
      if (albumId == null || albumId === '') break
      if (albumId === 'unknown') {
        scopeConditions.push(mediaModel.sqlLocationIsUnknown('i'))
      } else {
        scopeConditions.push(`(${mediaModel.sqlLocationKeyNullable('i')}) = ?`)
        scopeParams.push(String(albumId))
      }
      break
    case 'people':
      if (clusterId != null && !Number.isNaN(Number(clusterId)) && userId != null) {
        scopeConditions.push(
          'i.id IN (SELECT mfe.media_id FROM media_face_embeddings mfe INNER JOIN face_clusters fc ON mfe.id = fc.face_embedding_id WHERE fc.user_id = ? AND fc.cluster_id = ?)'
        )
        scopeParams.push(userId, Number(clusterId))
      }
      break
    case 'search':
    default:
      break
  }

  return { scopeConditions, scopeParams }
}

/**
 * 构建筛选 WHERE；注入 media 表地点键表达式（经 model），供 controller 仅调 service 时使用。
 * @param {object} filters - 筛选条件对象。
 * @param {object} filterOptions - 筛选构造配置。
 * @returns {{whereConditions: string[], whereParams: any[]}} 条件与参数。
 */
function buildFilterQueryParts(filters, filterOptions) {
  return buildSearchQueryParts(filters, {
    ...filterOptions,
    locationKeyExpr: mediaModel.sqlLocationKeyNullable('i')
  })
}

/**
 * 将 scope 条件与筛选条件合并成最终 WHERE 条件与参数。
 * @param {string[]} scopeConditions scope 条件数组
 * @param {any[]} scopeParams scope 参数数组
 * @param {{whereConditions: string[], whereParams: any[]}} built 由筛选构造返回的条件对象
 * @returns {{whereConditions: string[], whereParams: any[]}}
 */
function mergeScopeWhere(scopeConditions, scopeParams, built) {
  return {
    whereConditions: [...(scopeConditions || []), ...built.whereConditions],
    whereParams: [...(scopeParams || []), ...built.whereParams]
  }
}

module.exports = {
  buildScopeConditions,
  buildFilterQueryParts,
  mergeScopeWhere
}
