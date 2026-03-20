/*
 * @Description: 中文场景搜索查询解析器
 * 将自然语言查询中的主体、动作、场景信号解析为结构化语义组，
 * 供搜索排序层做“角色命中 + 组合命中”加分。
 * residualQuery 仅从句中去掉「时间、城市」已转结构化筛选的片段；主体/动作/场景不剥离，须进入 FTS。
 */
const {
  SUBJECT_DICTIONARY,
  ACTION_DICTIONARY,
  SCENE_DICTIONARY,
} = require("../config/searchSemanticDictionary");
const { normalizeQueryText, collectMatches, collectResidualQuery } = require("./querySemanticMatcher");
const { collectCitySignals, buildLocationFilter } = require("./queryLocationParser");
const { collectTimeSignals, pickPrimaryTimeFilter } = require("./queryTimeParser");

function parseQuerySemanticSignals(query) {
  const normalizedQuery = normalizeQueryText(query);
  const subjects = collectMatches(normalizedQuery, SUBJECT_DICTIONARY);
  const actions = collectMatches(normalizedQuery, ACTION_DICTIONARY);
  const scenes = collectMatches(normalizedQuery, SCENE_DICTIONARY);
  const cities = collectCitySignals(normalizedQuery);
  const timeSignals = collectTimeSignals(normalizedQuery);
  const allSignals = [
    ...subjects.map((group) => ({ category: "subject", ...group })),
    ...actions.map((group) => ({ category: "action", ...group })),
    ...scenes.map((group) => ({ category: "scene", ...group })),
    ...cities.map((group) => ({ category: "city", ...group })),
    ...timeSignals.map((group) => ({ category: "time", ...group })),
  ];
  const rangesStrippedForStructuredFilters = [
    ...cities.flatMap((group) => group.matchedRanges || []),
    ...timeSignals.flatMap((group) => group.matchedRanges || []),
  ];
  const { residualQuery, residualSegments } = collectResidualQuery(normalizedQuery, rangesStrippedForStructuredFilters);

  return {
    normalizedQuery,
    subjects,
    actions,
    scenes,
    cities,
    timeSignals,
    allSignals,
    summary: {
      subjectLabels: subjects.map((group) => group.label),
      actionLabels: actions.map((group) => group.label),
      sceneLabels: scenes.map((group) => group.label),
      cityLabels: cities.map((group) => group.label),
      timeLabels: timeSignals.map((group) => group.label),
    },
    primaryTimeFilter: pickPrimaryTimeFilter(timeSignals),
    primaryLocationFilter: buildLocationFilter(cities),
    residualQuery,
    residualSegments,
    hasRoleSignals: subjects.length > 0 || actions.length > 0 || scenes.length > 0,
    hasStructuredSignals:
      subjects.length > 0
      || actions.length > 0
      || scenes.length > 0
      || cities.length > 0
      || timeSignals.length > 0,
  };
}

module.exports = {
  parseQuerySemanticSignals,
  normalizeQueryText,
};
