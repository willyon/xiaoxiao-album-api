/**
 * 媒体城市与模糊图查询：城市分组/明细与模糊图列表、批量标记。
 */
const { db } = require("../../db");
const { mapFields } = require("../../utils/fieldMapper");
const { sqlLocationKeyNullable, sqlLocationAlbumKey, sqlLocationIsUnknown } = require("./mediaLocationSql");
const { buildCoverRankOrderSql } = require("./mediaCoverRankSql");

const MEDIA_CITY_DETAIL_SELECT_COLUMNS = `
  m.id, m.high_res_storage_key, m.thumbnail_storage_key, m.original_storage_key, m.media_type, m.duration_sec,
  m.captured_at, m.date_key, m.day_key, m.month_key, m.year_key, m.gps_location, m.width_px, m.height_px, m.aspect_ratio,
  m.layout_type, m.file_size_bytes, m.face_count, m.person_count, m.age_tags, m.expression_tags, m.is_favorite
`;

function buildCityMatchCondition({ albumId, tableAlias = "m" }) {
  const isUnknown = albumId === "unknown";
  const locKey = sqlLocationKeyNullable(tableAlias);
  return {
    isUnknown,
    condition: isUnknown ? ` AND ${sqlLocationIsUnknown(tableAlias)}` : ` AND (${locKey}) = ?`,
  };
}

/**
 * 查询模糊图分页列表。
 * @param {{userId:number|string,pageNo:number,pageSize:number}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function getMediasByBlurry({ userId, pageNo, pageSize }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT
      id, high_res_storage_key, thumbnail_storage_key, captured_at, created_at, date_key, day_key, month_key, year_key,
      gps_location, width_px, height_px, aspect_ratio, layout_type, file_size_bytes, face_count, person_count, age_tags,
      expression_tags, is_favorite
    FROM media
    WHERE user_id = ? AND is_blurry = 1 AND deleted_at IS NULL
    ORDER BY sharpness_score ASC, id ASC
    LIMIT ? OFFSET ?
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(*) AS total
    FROM media
    WHERE user_id = ? AND is_blurry = 1 AND deleted_at IS NULL
  `);
  const data = dataQuery.all(userId, pageSize, offset);
  const { total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

/**
 * 按用户批量更新模糊标记（集合内置 1，集合外置 0）。
 * @param {number|string} userId 用户 ID
 * @param {Array<number|string>} blurryImageIds 应标记为模糊的媒体 ID 列表
 * @returns {void}
 */
function updateBlurryForUser(userId, blurryImageIds) {
  if (!userId) return;
  const idsSet = blurryImageIds && blurryImageIds.length > 0 ? blurryImageIds : [];
  const placeholders = idsSet.length > 0 ? idsSet.map(() => "?").join(", ") : "";

  const markBlurry =
    idsSet.length > 0
      ? db.prepare(`
        UPDATE media SET is_blurry = 1
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
      `)
      : null;

  const clearBlurrySql =
    idsSet.length > 0
      ? `UPDATE media SET is_blurry = 0 WHERE user_id = ? AND deleted_at IS NULL AND id NOT IN (${placeholders})`
      : `UPDATE media SET is_blurry = 0 WHERE user_id = ? AND deleted_at IS NULL`;
  const clearBlurry = db.prepare(clearBlurrySql);

  if (markBlurry) markBlurry.run(userId, ...idsSet);
  if (idsSet.length > 0) clearBlurry.run(userId, ...idsSet);
  else clearBlurry.run(userId);
}

/**
 * 查询按城市分组封面分页列表。
 * @param {{pageNo:number,pageSize:number,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectGroupsByCity({ pageNo, pageSize, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const albumKey = sqlLocationAlbumKey("m");
  const coverRankOrderSql = buildCoverRankOrderSql();
  const mediaTypeClause = " AND (COALESCE(m.media_type, 'image') IN ('image', 'video', 'audio'))";
  const baseWhereClause = "m.user_id = ? AND m.deleted_at IS NULL";
  const dataQuery = db.prepare(`
    WITH city_normalized AS (
      SELECT m.id, ${albumKey} AS city_key, m.expression_tags, m.face_count, m.person_count, m.preferred_face_quality, m.thumbnail_storage_key, m.captured_at
      FROM media AS m
      WHERE ${baseWhereClause}${mediaTypeClause}
    ),
    ranked_images AS (
      SELECT city_key, thumbnail_storage_key, captured_at, id,
        ROW_NUMBER() OVER (
          PARTITION BY city_key
          ORDER BY
            ${coverRankOrderSql}
        ) AS rn
      FROM city_normalized
    ),
    latest AS (
      SELECT city_key, thumbnail_storage_key, captured_at, id FROM ranked_images WHERE rn = 1
    ),
    counts AS (
      SELECT city_key, COUNT(*) AS mediaCount FROM city_normalized GROUP BY city_key
    )
    SELECT latest.city_key AS album_id, latest.thumbnail_storage_key AS latestImagekey, latest.captured_at, counts.mediaCount
    FROM latest
    JOIN counts ON counts.city_key = latest.city_key
    ORDER BY CASE WHEN latest.city_key = 'unknown' THEN 1 ELSE 0 END, counts.mediaCount DESC, latest.city_key ASC
    LIMIT ? OFFSET ?;
  `);
  const countQuery = db.prepare(`
    SELECT COUNT(DISTINCT ${albumKey}) AS groupCount
    FROM media AS m
    WHERE ${baseWhereClause}${mediaTypeClause};
  `);
  const data = dataQuery.all(userId, pageSize, offset);
  const { groupCount: total } = countQuery.get(userId);
  return { data: mapFields("media", data), total };
}

/**
 * 查询指定城市（或 unknown）媒体分页列表。
 * @param {{pageNo:number,pageSize:number,albumId:string,userId:number|string}} params 查询参数
 * @returns {{data:Array<object>,total:number}} 分页结果
 */
function selectMediasByCity({ pageNo, pageSize, albumId, userId }) {
  const offset = (pageNo - 1) * pageSize;
  const { isUnknown, condition: cityCondition } = buildCityMatchCondition({ albumId, tableAlias: "m" });
  const baseWhereClause = "m.user_id = ? AND m.deleted_at IS NULL";
  const baseSelect = `
    SELECT
      ${MEDIA_CITY_DETAIL_SELECT_COLUMNS}
    FROM media AS m
    WHERE ${baseWhereClause}
  `;
  const orderLimit = " ORDER BY COALESCE(m.captured_at, 0) DESC, m.id DESC LIMIT ? OFFSET ?";
  const dataQuery = db.prepare(baseSelect + cityCondition + orderLimit);
  const countQuery = db.prepare(`SELECT COUNT(*) AS total FROM media AS m WHERE ${baseWhereClause}${cityCondition}`);

  const params = isUnknown ? [userId, pageSize, offset] : [userId, albumId, pageSize, offset];
  const countParams = isUnknown ? [userId] : [userId, albumId];
  const data = dataQuery.all(...params);
  const { total } = countQuery.get(...countParams);
  return { data: mapFields("media", data), total };
}

module.exports = {
  getMediasByBlurry,
  updateBlurryForUser,
  selectGroupsByCity,
  selectMediasByCity,
};
