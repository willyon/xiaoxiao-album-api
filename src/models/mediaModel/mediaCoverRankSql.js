/**
 * 媒体封面排序 SQL 片段：统一年/月/日/城市/人物分组中封面优先级逻辑。
 *
 * 设计目标：
 * 1) 优先挑“有人像且观感好”的图片做分组封面；
 * 2) 在同优先级中再按质量与时间做稳定排序；
 * 3) 把规则集中在一个地方，避免各查询文件出现不一致。
 */

/**
 * 生成封面排序优先级 SQL（情绪优先 + 质量优先）。
 *
 * 规则说明（从高到低）：
 * - 优先级 1：检测到人脸，且表情含 happy；
 * - 优先级 2：检测到人脸，不含 happy 但含 neutral；
 * - 优先级 3：检测到人脸（其余表情）；
 * - 优先级 4：无人脸但检测到人物；
 * - 优先级 5：其余兜底（无人脸无人物或分析信息缺失）。
 *
 * 同优先级下继续比较：
 * - `preferred_face_quality`（更清晰的人脸优先）
 * - `face_count`（多人脸更优）
 * - `person_count`（有人物更优）
 * - `captured_at`（更近时间优先）
 * - `id`（最终稳定排序，避免翻页抖动）
 *
 * @param {string} [alias=""] 字段别名前缀（如 "i"），不传则使用裸字段名
 * @returns {string} 可直接拼接到 ORDER BY 的 SQL 片段
 */
function buildCoverRankOrderSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `
    -- 第一段：粗粒度优先级（情绪/是否有人脸/是否有人物）
    CASE
      WHEN ${p}face_count > 0
           AND ((',' || REPLACE(COALESCE(${p}expression_tags,''),' ','') || ',') LIKE '%,happy,%')
           THEN 1
      WHEN ${p}face_count > 0
           AND ((',' || REPLACE(COALESCE(${p}expression_tags,''),' ','') || ',') NOT LIKE '%,happy,%')
           AND ((',' || REPLACE(COALESCE(${p}expression_tags,''),' ','') || ',') LIKE '%,neutral,%')
           THEN 2
      WHEN ${p}face_count > 0 THEN 3
      WHEN ${p}person_count > 0 THEN 4
      ELSE 5
    END,
    -- 第二段：细粒度排序（质量 > 人脸数量 > 人物数量 > 时间 > 主键）
    COALESCE(${p}preferred_face_quality, 0) DESC,
    COALESCE(${p}face_count, 0) DESC,
    COALESCE(${p}person_count, 0) DESC,
    COALESCE(${p}captured_at, 0) DESC,
    ${p}id DESC
  `;
}

module.exports = {
  buildCoverRankOrderSql,
};
