/*
 * @Description: 搜索排序与评分权重配置
 * 调参约定：
 * 1. 先调字段基础权重（term 命中），再调 FTS 基础分。
 * 2. subject/action/scene 等标签字段的 term 权重仍高于 keywords/description。
 * 3. 若结果过度偏向“最新图片”，优先检查 FTS 基础分。
 */

// 中文 term 命中基础权重。
// 用于 media_search_terms 召回后的字段打分，决定“命中哪个字段更重要”。
// 建议关系：action_tags >= subject_tags >= scene_tags > keywords > description。
const SEARCH_TERM_FIELD_WEIGHTS = {
  subject_tags: 180,
  action_tags: 200,
  scene_tags: 170,
  keywords: 120,
  description: 100,
  /** ocr_text 子串 LIKE 命中加分（不经 media_search_terms） */
  ocrLikeHit: 85,
  transcript: 65,
};

// 查询词自身加分。
// 双字及以上词比单字更可靠，因此给予更高 boost。
// 如果单字查询召回过强，可优先下调 singleChar。
const CHINESE_QUERY_TERM_BOOST = {
  singleChar: 16,
  multiChar: 40,
};

// FTS 排名融合分。
// 非中文查询主要依赖 FTS，因此基础分更高。
// 如果英文或视觉 FTS 结果偏弱，可优先提升 nonChineseBaseScore。
const FTS_RANKING = {
  chineseBaseScore: 28,
  nonChineseBaseScore: 90,
  minScore: 6,
};

module.exports = {
  SEARCH_TERM_FIELD_WEIGHTS,
  CHINESE_QUERY_TERM_BOOST,
  FTS_RANKING,
};
