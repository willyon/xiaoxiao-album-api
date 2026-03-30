/*
 * @Description: 中文分词（@node-rs/jieba）+ 可选用户词表，供 caption_search_terms 与查询侧对齐
 */
const fs = require("fs");
const path = require("path");

const HAS_CHINESE_REGEX = /[\u3400-\u9fff]/;
const SEARCH_TERMS_SPLIT_REGEX = /[\s\u3000,.;:!?、，。；：！？/\\|'"()[\]{}]+/u;

const USER_DICT_PATH = path.join(__dirname, "../config/search-user-dict.txt");

let jiebaSingleton = null;
let jiebaLoadFailed = false;
/** @type {{ mtimeMs: number | null, exists: boolean } | null } */
let userDictRecordedSnapshot = null;

function getUserDictSnapshot() {
  try {
    if (!fs.existsSync(USER_DICT_PATH)) {
      return { mtimeMs: null, exists: false };
    }
    const st = fs.statSync(USER_DICT_PATH);
    return { mtimeMs: st.mtimeMs, exists: true };
  } catch {
    return { mtimeMs: null, exists: false };
  }
}

function userDictSnapshotEquals(a, b) {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.exists === b.exists;
}

/**
 * 用户词表文件变更后自动重建 jieba（无需重启进程）；加载失败时保留旧快照，避免对同一坏文件刷屏重试。
 */
function tryCreateJieba() {
  const cur = getUserDictSnapshot();
  const userDictDirty = !userDictSnapshotEquals(cur, userDictRecordedSnapshot);

  if (jiebaSingleton && !userDictDirty) {
    return jiebaSingleton;
  }

  if (userDictDirty) {
    jiebaSingleton = null;
    jiebaLoadFailed = false;
  }

  if (jiebaLoadFailed) {
    return null;
  }

  try {
    const { Jieba } = require("@node-rs/jieba");
    const { dict } = require("@node-rs/jieba/dict");
    let mergedDict = dict;
    if (cur.exists && fs.existsSync(USER_DICT_PATH)) {
      const raw = fs.readFileSync(USER_DICT_PATH, "utf-8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .join("\n");
      if (lines.length > 0) {
        mergedDict = Buffer.concat([dict, Buffer.from(`\n${lines}`, "utf-8")]);
      }
    }
    jiebaSingleton = Jieba.withDict(mergedDict);
    userDictRecordedSnapshot = cur;
    return jiebaSingleton;
  } catch (err) {
    jiebaLoadFailed = true;
    userDictRecordedSnapshot = cur;
    console.error("[chineseSegmenter] jieba load failed:", err?.message || err);
    return null;
  }
}

function isOnlyPunctOrSpace(s) {
  return !s || !/[\w\u3400-\u9fff]/u.test(s);
}

/**
 * 单段文本 → 检索用 token（无中文时按空白/标点切；有中文时用 jieba 搜索模式，失败则回退标点切）
 */
function segmentFieldForSearchTerms(text) {
  if (!text || typeof text !== "string") {
    return [];
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (!HAS_CHINESE_REGEX.test(trimmed)) {
    return trimmed
      .split(SEARCH_TERMS_SPLIT_REGEX)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (/^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t));
  }
  const jieba = tryCreateJieba();
  if (jieba) {
    const parts = jieba.cutForSearch(trimmed, true);
    const out = [];
    for (const w of parts) {
      const t = w.trim();
      if (!t || isOnlyPunctOrSpace(t)) continue;
      out.push(/^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t);
    }
    if (out.length > 0) {
      return out;
    }
  }
  return trimmed
    .split(SEARCH_TERMS_SPLIT_REGEX)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^[\x00-\x7f]+$/.test(t) ? t.toLowerCase() : t));
}

/**
 * 整句用户查询 → 空格分隔，供 FTS MATCH 与分词后 token 对齐
 */
function normalizeChineseQueryForFts(query) {
  const raw = String(query || "").trim();
  if (!raw || !HAS_CHINESE_REGEX.test(raw)) {
    return raw;
  }
  const jieba = tryCreateJieba();
  if (!jieba) {
    return raw;
  }
  const parts = jieba.cutForSearch(raw, true);
  const words = parts.map((w) => w.trim()).filter((w) => w.length > 0 && !isOnlyPunctOrSpace(w));
  return words.length > 0 ? words.join(" ") : raw;
}

module.exports = {
  tryCreateJieba,
  segmentFieldForSearchTerms,
  normalizeChineseQueryForFts,
  /** 与 `segmentFieldForSearchTerms` 无中文分支一致，供视觉向量字面门闩等复用 */
  SEARCH_TERMS_SPLIT_REGEX,
};
