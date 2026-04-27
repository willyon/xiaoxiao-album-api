/**
 * 媒体时间轴分组查询：按年/月/日获取分组封面分页。
 */
const { db } = require("../../db");
const { mapFields } = require("../../utils/fieldMapper");
const { buildCoverRankOrderSql } = require("./mediaCoverRankSql");

function selectTimelineGroupsByDimension({ pageNo, pageSize, userId, dimensionField }) {
  const offset = (pageNo - 1) * pageSize;
  const coverRankOrderSql = buildCoverRankOrderSql();
  const dataQuery = db.prepare(`
    WITH ranked_images AS (
      SELECT ${dimensionField}, expression_tags, face_count, person_count, preferred_face_quality, thumbnail_storage_key, captured_at, id,
        ROW_NUMBER() OVER (
          PARTITION BY ${dimensionField}
          ORDER BY
            ${coverRankOrderSql}
        ) AS rn
      FROM media
      WHERE user_id = ? AND deleted_at IS NULL AND ${dimensionField} != 'unknown'
        AND (COALESCE(media_type, 'image') IN ('image', 'video', 'audio'))
    ),
    latest AS (
      SELECT ${dimensionField}, thumbnail_storage_key, captured_at, id FROM ranked_images WHERE rn = 1
    ),
    counts AS (
      SELECT ${dimensionField}, COUNT(*) AS mediaCount
      FROM media
      WHERE user_id = ? AND deleted_at IS NULL AND ${dimensionField} != 'unknown'
      GROUP BY ${dimensionField}
    )
    SELECT latest.${dimensionField} AS album_id, latest.thumbnail_storage_key AS latestImagekey, latest.captured_at, counts.mediaCount
    FROM latest
    JOIN counts ON counts.${dimensionField} = latest.${dimensionField}
    ORDER BY latest.${dimensionField} DESC
    LIMIT ? OFFSET ?;
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT ${dimensionField}) AS groupCount
    FROM media
    WHERE user_id = ? AND deleted_at IS NULL AND ${dimensionField} != 'unknown';
  `);
  const data = dataQuery.all(userId, userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

/**
 * 查询按月分组封面分页列表。
 * @param {{pageNo:number,pageSize:number,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectGroupsByMonth({ pageNo, pageSize, userId }) {
  return selectTimelineGroupsByDimension({
    pageNo,
    pageSize,
    userId,
    dimensionField: "month_key",
  });
}

/**
 * 查询按年分组封面分页列表。
 * @param {{pageNo:number,pageSize:number,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectGroupsByYear({ pageNo, pageSize, userId }) {
  return selectTimelineGroupsByDimension({
    pageNo,
    pageSize,
    userId,
    dimensionField: "year_key",
  });
}

/**
 * 查询按日分组封面分页列表。
 * @param {{pageNo:number,pageSize:number,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectGroupsByDate({ pageNo, pageSize, userId }) {
  return selectTimelineGroupsByDimension({
    pageNo,
    pageSize,
    userId,
    dimensionField: "date_key",
  });
}

module.exports = {
  selectGroupsByMonth,
  selectGroupsByYear,
  selectGroupsByDate,
};
