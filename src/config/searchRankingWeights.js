/*
 * @Description: 搜索排序与评分权重配置
 * 调参约定：
 * 1. 先调字段基础权重，再调结构化角色/组合加分，最后再调 FTS 基础分。
 * 2. 结构化标签（subject/action/scene）应始终高于 keywords/description。
 * 3. 组合命中加分应明显高于单角色加分，但不要高到压死纯文本召回。
 * 4. 如果查询开始过度偏向“最新图片”，优先检查 FTS 基础分和组合加分是否过低。
 *
 * 默认期望行为：
 * - “宝宝吃饭” 应明显高于只命中 “宝宝” 的结果。
 * - “客厅看电视” 应优先命中同时包含场景和动作线索的结果。
 * - 单字查询如 “张” 仍应可召回，但不能压过明确的多词场景查询。
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
  ocr: 85,
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
// 非中文查询主要依赖 FTS，因此基础分更高；中文查询更多依赖 term + 结构化加分。
// 如果英文/OCR 搜索结果偏弱，可优先提升 nonChineseBaseScore。
const FTS_RANKING = {
  chineseBaseScore: 28,
  nonChineseBaseScore: 90,
  minScore: 6,
};

// 查询语义解析后，主体/动作/场景各自命中的额外加分。
// 动作通常最能区分结果，因此略高于主体和场景。
// 如果“宝宝吃饭”仍被大量“宝宝玩耍”淹没，优先上调 action。
const STRUCTURED_ROLE_BOOSTS = {
  subject: 48,
  action: 66,
  scene: 40,
};

// 多角色组合命中的额外加分。
// 目标：让“主体 + 动作(+ 场景)”显著高于只命中单个高频词的结果。
// 如果组合查询排序仍不够稳，优先调这里，不要先把字段基础权重拉得过高。
const STRUCTURED_COMBO_BOOSTS = {
  subjectActionScene: 140,
  subjectAction: 110,
  subjectScene: 72,
  actionScene: 82,
};

module.exports = {
  SEARCH_TERM_FIELD_WEIGHTS,
  CHINESE_QUERY_TERM_BOOST,
  FTS_RANKING,
  STRUCTURED_ROLE_BOOSTS,
  STRUCTURED_COMBO_BOOSTS,
};
