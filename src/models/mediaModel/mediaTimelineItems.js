/**
 * 媒体时间轴明细查询：按年/月/日获取媒体分页列表。
 */
const { db } = require("../../db");
const { mapFields } = require("../../utils/fieldMapper");

const MEDIA_SELECT_COLUMNS = `
  id, high_res_storage_key, thumbnail_storage_key, original_storage_key, media_type, duration_sec,
  captured_at, date_key, day_key, month_key, year_key, gps_location, width_px, height_px, aspect_ratio,
  layout_type, file_size_bytes, face_count, person_count, age_tags, expression_tags, is_favorite
`;

const MEDIA_SELECT_COLUMNS_WITH_CLUSTER = `
  i.id,
  i.high_res_storage_key,
  i.thumbnail_storage_key,
  i.original_storage_key,
  i.media_type,
  i.duration_sec,
  i.captured_at,
  i.date_key,
  i.day_key,
  i.month_key,
  i.year_key,
  i.gps_location,
  i.width_px,
  i.height_px,
  i.aspect_ratio,
  i.layout_type,
  i.file_size_bytes,
  i.face_count,
  i.person_count,
  i.age_tags,
  i.expression_tags,
  i.is_favorite,
  MIN(fe.id) AS face_embedding_id
`;

function selectTimelineMediasByDimension({ pageNo, pageSize, dimensionField, dimensionValue, userId, clusterId = null }) {
  const offset = (pageNo - 1) * pageSize;
  const hasClusterFilter = clusterId !== null && clusterId !== undefined;

  if (hasClusterFilter) {
    const dataQuery = db.prepare(`
      SELECT
        ${MEDIA_SELECT_COLUMNS_WITH_CLUSTER}
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.${dimensionField} = ?
        AND fc.user_id = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
      GROUP BY i.id
      ORDER BY i.captured_at DESC, i.id DESC
      LIMIT ? OFFSET ?
    `);

    const countQuery = db.prepare(`
      SELECT COUNT(DISTINCT i.id) AS total
      FROM media i
      INNER JOIN media_face_embeddings fe ON i.id = fe.media_id
      INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
      WHERE i.user_id = ?
        AND i.${dimensionField} = ?
        AND fc.user_id = ?
        AND fc.cluster_id = ?
        AND i.deleted_at IS NULL
    `);

    const data = dataQuery.all(userId, dimensionValue, userId, clusterId, pageSize, offset);
    const { total } = countQuery.get(userId, dimensionValue, userId, clusterId);
    return { data: mapFields("media", data), total };
  }

  const dataQuery = db.prepare(`
    SELECT
      ${MEDIA_SELECT_COLUMNS}
    FROM media
    WHERE user_id = ?
      AND ${dimensionField} = ?
      AND deleted_at IS NULL
    ORDER BY COALESCE(captured_at, 0) DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media
    WHERE user_id = ?
      AND ${dimensionField} = ?
      AND deleted_at IS NULL
  `);

  const data = dataQuery.all(userId, dimensionValue, pageSize, offset);
  const { total } = countQuery.get(userId, dimensionValue);
  return { data: mapFields("media", data), total };
}

/**
 * 查询指定年份媒体分页列表（支持按人物 cluster 过滤）。
 * @param {{pageNo:number,pageSize:number,albumId:string,userId:number|string,clusterId?:number|null}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectMediasByYear({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  return selectTimelineMediasByDimension({
    pageNo,
    pageSize,
    dimensionField: "year_key",
    dimensionValue: albumId,
    userId,
    clusterId,
  });
}

/**
 * 查询指定月份媒体分页列表（支持按人物 cluster 过滤）。
 * @param {{pageNo:number,pageSize:number,albumId:string,userId:number|string,clusterId?:number|null}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectMediasByMonth({ pageNo, pageSize, albumId, userId, clusterId = null }) {
  return selectTimelineMediasByDimension({
    pageNo,
    pageSize,
    dimensionField: "month_key",
    dimensionValue: albumId,
    userId,
    clusterId,
  });
}

/**
 * 查询指定日期媒体分页列表。
 * @param {{pageNo:number,pageSize:number,albumId:string,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectMediasByDate({ pageNo, pageSize, albumId, userId }) {
  return selectTimelineMediasByDimension({
    pageNo,
    pageSize,
    dimensionField: "date_key",
    dimensionValue: albumId,
    userId,
  });
}

module.exports = {
  selectMediasByYear,
  selectMediasByMonth,
  selectMediasByDate,
};
