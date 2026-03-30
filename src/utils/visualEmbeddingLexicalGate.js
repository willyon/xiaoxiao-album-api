/*
 * @Description: 视觉文本向量字面门闩用词（与 docs/视觉文本向量搜索链路说明.md §9 一致）
 * residual.trim() → 中英数分段 → SEARCH_TERMS_SPLIT_REGEX → 中文长片 jieba → 种子去重 → 仅含中文种子剔 SEARCH_NOISE_TERMS → expandTermsWithSynonyms
 * 不涉及 WEAK_VERBS；query 向量仍用全文 residual.trim()（searchService 侧）。
 */
const { tryCreateJieba, SEARCH_TERMS_SPLIT_REGEX } = require("./chineseSegmenter");
const { isStopWordWholeSegment } = require("./embeddingLexicalGate");
const { buildSynonymGroups } = require("./searchSynonymExpansion");

const HAS_CJK = /[\u3400-\u9fff]/;

function isOnlyPunctOrSpace(s) {
  return !s || !/[\w\u3400-\u9fff]/u.test(s);
}

/**
 * 连续 CJK、连续 [A-Za-z0-9]（含 iPhone15 类混合）拆成相邻片段；标点等不入片段。
 */
function splitCjkAndAlnumRuns(s) {
  const runs = [];
  let buf = "";
  /** @type {"cjk" | "alnum" | null} */
  let mode = null;
  const flush = () => {
    if (buf) {
      runs.push(buf);
      buf = "";
      mode = null;
    }
  };
  for (const ch of s) {
    const isCjk = HAS_CJK.test(ch);
    const isAlnum = /[A-Za-z0-9]/.test(ch);
    if (isCjk) {
      if (mode === "alnum") flush();
      mode = "cjk";
      buf += ch;
    } else if (isAlnum) {
      if (mode === "cjk") flush();
      mode = "alnum";
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

function splitRunBySearchDelimiters(run) {
  return String(run)
    .split(SEARCH_TERMS_SPLIT_REGEX)
    .map((t) => t.trim())
    .filter(Boolean);
}

function countCodePoints(s) {
  return Array.from(String(s)).length;
}

function isPureAsciiAlnum(s) {
  return /^[A-Za-z0-9]+$/.test(s);
}

/**
 * 英文/数字片：整段保留（小写）；中文片：码点长度 > 2 则 jieba，否则整段。
 */
function sliceToSeeds(piece) {
  const trimmed = String(piece || "").trim();
  if (!trimmed) return [];
  if (isPureAsciiAlnum(trimmed)) {
    return [trimmed.toLowerCase()];
  }
  if (countCodePoints(trimmed) <= 2) {
    return [trimmed];
  }
  const jieba = tryCreateJieba();
  if (!jieba) {
    return [trimmed];
  }
  const parts = jieba.cutForSearch(trimmed, true);
  const out = [];
  for (const w of parts) {
    const t = w.trim();
    if (!t || isOnlyPunctOrSpace(t)) continue;
    out.push(/^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t);
  }
  return out.length > 0 ? out : [trimmed];
}

/** 仅含 CJK 的种子若整段为停用词则剔除；纯英文/数字种子不比 stop 表（与 embeddingLexicalGate 规则一致）。 */
function dropChineseStopSeeds(seeds) {
  const out = [];
  for (const s of seeds) {
    if (!s) continue;
    if (HAS_CJK.test(s) && isStopWordWholeSegment(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * @param {string} residual
 * @returns {string[]} 扩展后的字面词表，供 passLexicalGate
 */
function buildVisualEmbeddingGateLexicalTokens(residual) {
  return buildVisualEmbeddingGateLexicalSpec(residual).tokens;
}

function buildVisualEmbeddingGateLexicalSpec(residual) {
  const raw = String(residual || "").trim();
  if (!raw) {
    return {
      seeds: [],
      groups: [],
      tokens: [],
    };
  }
  const seedSet = new Set();
  for (const run of splitCjkAndAlnumRuns(raw)) {
    for (const piece of splitRunBySearchDelimiters(run)) {
      for (const seed of sliceToSeeds(piece)) {
        if (seed) seedSet.add(seed);
      }
    }
  }
  const filtered = dropChineseStopSeeds([...seedSet]);
  const groups = buildSynonymGroups(filtered);
  const tokenSet = new Set();
  groups.forEach((group) => {
    group.forEach((token) => {
      const t = String(token || "").trim();
      if (t) tokenSet.add(t);
    });
  });
  return {
    seeds: filtered,
    groups,
    tokens: Array.from(tokenSet),
  };
}

module.exports = {
  buildVisualEmbeddingGateLexicalTokens,
  buildVisualEmbeddingGateLexicalSpec,
  splitCjkAndAlnumRuns,
};
