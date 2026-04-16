/*
 * CJK 常用 Unicode 段 \u3400-\u9FFF（与各检索/分词历史行为一致），单点导出避免多处复制。
 */

/** 是否包含至少一个 CJK 表意文字 */
const HAS_CHINESE_REGEX = /[\u3400-\u9fff]/

/** 连续 CJK 跑（全局） */
const CHINESE_RUN_REGEX = /[\u3400-\u9fff]+/g

/** 每个 CJK 字单独匹配（全局，用于 match / replace） */
const CHINESE_CHARS_GLOBAL_REGEX = /[\u3400-\u9fff]/g

/** \w ∪ CJK，用于「是否仅标点/空白」类判断（对字符串取反） */
const WORD_OR_CJK_REGEX = /[\w\u3400-\u9fff]/u

/** FTS sanitize：允许不加引号的 token 字符集 */
const SANITIZE_FTS_TOKEN_CHAR_PATTERN = /^[\p{L}\p{N}_\u3400-\u9fff*]+$/u

module.exports = {
  HAS_CHINESE_REGEX,
  /** 与 HAS_CHINESE_REGEX 同义，便于调用方语义命名 */
  HAS_CJK: HAS_CHINESE_REGEX,
  CHINESE_RUN_REGEX,
  CHINESE_CHARS_GLOBAL_REGEX,
  WORD_OR_CJK_REGEX,
  SANITIZE_FTS_TOKEN_CHAR_PATTERN
}
