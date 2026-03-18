/*
 * @Description: 中文 term 索引与查询工具
 */

const CHINESE_RUN_REGEX = /[\u3400-\u9fff]+/g;
const HAS_CHINESE_REGEX = /[\u3400-\u9fff]/;

const SEARCH_TERM_FIELD_WEIGHTS = {
  keywords: 120,
  caption: 100,
  ocr: 85,
  transcript: 65,
  location: 55,
};

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

function buildChineseQueryTerms(query) {
  const terms = generateChineseTerms(query, 2);
  return terms
    .map((term) => {
      const termLen = Array.from(term).length;
      return {
        term,
        termLen,
        boost: termLen >= 2 ? 40 : 16,
      };
    })
    .sort((a, b) => b.termLen - a.termLen || a.term.localeCompare(b.term, "zh-Hans-CN"));
}

module.exports = {
  SEARCH_TERM_FIELD_WEIGHTS,
  buildChineseQueryTerms,
  buildMediaSearchTermRows,
  containsChinese,
  extractChineseRuns,
  generateChineseTerms,
  normalizeSearchText,
};
