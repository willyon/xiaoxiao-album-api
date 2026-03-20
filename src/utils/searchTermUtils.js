/*
 * @Description: 中文 term 索引与查询工具
 */
const { SEARCH_TERM_FIELD_WEIGHTS, CHINESE_QUERY_TERM_BOOST } = require("../config/searchRankingWeights");
const {
  segmentFieldForSearchTerms,
  normalizeChineseQueryForFts,
} = require("./chineseSegmenter");

const CHINESE_RUN_REGEX = /[\u3400-\u9fff]+/g;
const HAS_CHINESE_REGEX = /[\u3400-\u9fff]/;

function containsChinese(input) {
  return HAS_CHINESE_REGEX.test(String(input || ""));
}

function normalizeSearchText(input) {
  return String(input || "").trim();
}

function extractChineseRuns(input) {
  const text = normalizeSearchText(input);
  if (!text) return [];
  const matches = text.match(CHINESE_RUN_REGEX);
  return Array.isArray(matches) ? matches.map((item) => item.trim()).filter(Boolean) : [];
}

function generateChineseTerms(input, maxTermLength = 2) {
  const runs = extractChineseRuns(input);
  const terms = new Set();

  for (const run of runs) {
    const chars = Array.from(run);
    for (let start = 0; start < chars.length; start += 1) {
      for (let len = 1; len <= maxTermLength; len += 1) {
        const term = chars.slice(start, start + len).join("");
        if (term && term.length === len) {
          terms.add(term);
        }
      }
    }
  }

  return Array.from(terms);
}

function buildMediaSearchTermRows({ mediaId, userId, fields, updatedAt = Date.now() }) {
  const rows = [];

  for (const [fieldType, value] of Object.entries(fields || {})) {
    const terms = generateChineseTerms(value, 2);
    for (const term of terms) {
      rows.push({
        mediaId,
        userId,
        fieldType,
        term,
        termLen: Array.from(term).length,
        updatedAt,
      });
    }
  }

  return rows;
}

const FIELD_KEYS_FOR_SEARCH_TERMS = [
  "caption",
  "keywords",
  "subject_tags",
  "action_tags",
  "scene_tags",
  "ocr",
  "transcript",
];

/**
 * 合并图片理解 + OCR/转写等字段 → 按字段分词（中文 jieba 搜索模式，无中文则标点/空白切），去重保序，空格拼接。
 */
function buildSearchTermsFromFields(fields) {
  const seen = new Set();
  const tokens = [];
  for (const key of FIELD_KEYS_FOR_SEARCH_TERMS) {
    const v = fields && fields[key];
    if (typeof v !== "string" || !v.trim()) continue;
    for (const tok of segmentFieldForSearchTerms(v)) {
      if (!tok) continue;
      const dedupeKey = /^[\x00-\x7f]+$/.test(tok) ? tok : tok;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tokens.push(tok);
    }
  }
  return tokens.length > 0 ? tokens.join(" ") : null;
}

function buildChineseQueryTerms(query) {
  const text = normalizeSearchText(query);
  if (!text) {
    return [];
  }
  // 这里的 buildChineseQueryTerms 用于 media_search_terms 的精确命中（mst.term IN ...）。
  // 为避免把用户二字词拆成单字造成噪音：连续中文段长度为 1 只保留 1 字；长度为 2 只保留整段 2 字。
  if (!containsChinese(text)) {
    return [];
  }

  const runs = extractChineseRuns(text);
  const terms = new Set();
  for (const run of runs) {
    const runLen = Array.from(run).length;
    if (runLen === 1) {
      terms.add(run);
    } else if (runLen === 2) {
      terms.add(run);
    } else {
      // 防御性：如果意外进入（理应由 searchService token 过滤掉），仍只生成 2 字滑窗子串
      const chars = Array.from(run);
      for (let i = 0; i + 1 < chars.length; i += 1) {
        terms.add(chars.slice(i, i + 2).join(""));
      }
    }
  }

  return Array.from(terms)
    .map((term) => {
      const termLen = Array.from(term).length;
      return {
        term,
        termLen,
        boost: termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar,
      };
    })
    .sort((a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"));
}

function normalizeQueryForFts(query) {
  return normalizeChineseQueryForFts(query);
}

module.exports = {
  SEARCH_TERM_FIELD_WEIGHTS,
  buildChineseQueryTerms,
  buildMediaSearchTermRows,
  buildSearchTermsFromFields,
  containsChinese,
  extractChineseRuns,
  generateChineseTerms,
  normalizeQueryForFts,
  normalizeSearchText,
};
