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

/** 英文单词（≥2 字母，小写去重）与连续数字串（含 1 位） */
function extractEnglishWordAndDigitTerms(input) {
  const s = String(input || "");
  const terms = new Set();
  for (const m of s.matchAll(/[a-zA-Z]{2,}/g)) {
    terms.add(m[0].toLowerCase());
  }
  for (const m of s.matchAll(/[0-9]+/g)) {
    terms.add(m[0]);
  }
  return Array.from(terms);
}

/** 写入 media_search_terms：中文 1～2 字滑窗 + 英文词 + 连续数字 */
function generateMediaSearchTerms(input) {
  const terms = new Set();
  for (const t of generateChineseTerms(input, 2)) {
    terms.add(t);
  }
  for (const t of extractEnglishWordAndDigitTerms(input)) {
    terms.add(t);
  }
  return Array.from(terms);
}

function buildMediaSearchTermRows({ mediaId, userId, fields, updatedAt = Date.now() }) {
  const rows = [];

  for (const [fieldType, value] of Object.entries(fields || {})) {
    const terms = generateMediaSearchTerms(value);
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

// 合并进 search_terms（jieba）的字段：仅图片理解相关 + 转写；OCR 的 jieba 单独写入 media_search.ocr_search_terms
const FIELD_KEYS_FOR_SEARCH_TERMS = [
  "description",
  "keywords",
  "subject_tags",
  "action_tags",
  "scene_tags",
  "transcript",
];

/**
 * OCR 原文 → jieba 检索 token 空格拼接，写入 media_search.ocr_search_terms / FTS ocr_search_terms（与查询 normalizeQueryForFts 对齐）
 */
function buildOcrSearchTermsFromRaw(rawOcr) {
  if (!rawOcr || typeof rawOcr !== "string" || !rawOcr.trim()) return null;
  const tokens = [];
  const seen = new Set();
  for (const tok of segmentFieldForSearchTerms(rawOcr)) {
    if (!tok) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    tokens.push(tok);
  }
  return tokens.length > 0 ? tokens.join(" ") : null;
}

/**
 * 合并多字段 → jieba 搜索模式分词后写入 search_terms（不含 OCR；OCR 见 buildOcrSearchTermsFromRaw）
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
  // media_search_terms 精确命中（mst.term IN ...）：中文 + 英文词 + 数字串（与 generateMediaSearchTerms 对齐）
  const termMap = new Map();

  if (containsChinese(text)) {
    const runs = extractChineseRuns(text);
    for (const run of runs) {
      const runLen = Array.from(run).length;
      const terms = new Set();
      if (runLen === 1) {
        terms.add(run);
      } else if (runLen === 2) {
        terms.add(run);
      } else {
        const chars = Array.from(run);
        for (let i = 0; i + 1 < chars.length; i += 1) {
          terms.add(chars.slice(i, i + 2).join(""));
        }
      }
      for (const term of terms) {
        const termLen = Array.from(term).length;
        const boost = termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar;
        termMap.set(term, { term, termLen, boost });
      }
    }
  }

  for (const term of extractEnglishWordAndDigitTerms(text)) {
    const termLen = Array.from(term).length;
    const boost = termLen >= 2 ? CHINESE_QUERY_TERM_BOOST.multiChar : CHINESE_QUERY_TERM_BOOST.singleChar;
    if (!termMap.has(term)) {
      termMap.set(term, { term, termLen, boost });
    }
  }

  return Array.from(termMap.values()).sort(
    (a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"),
  );
}

function normalizeQueryForFts(query) {
  return normalizeChineseQueryForFts(query);
}

module.exports = {
  SEARCH_TERM_FIELD_WEIGHTS,
  buildChineseQueryTerms,
  buildMediaSearchTermRows,
  buildOcrSearchTermsFromRaw,
  /** @deprecated 使用 buildOcrSearchTermsFromRaw */
  buildOcrTextForSearchFts: buildOcrSearchTermsFromRaw,
  buildSearchTermsFromFields,
  containsChinese,
  extractChineseRuns,
  extractEnglishWordAndDigitTerms,
  generateChineseTerms,
  generateMediaSearchTerms,
  normalizeQueryForFts,
  normalizeSearchText,
};
