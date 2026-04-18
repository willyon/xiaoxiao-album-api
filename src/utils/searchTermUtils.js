/*
 * @Description: 中文 term 索引与查询工具
 */
const { segmentFieldForSearchTerms } = require('./chineseSegmenter')
const { CHINESE_CHARS_GLOBAL_REGEX, CHINESE_RUN_REGEX, HAS_CHINESE_REGEX } = require('./cjkRegex')

/**
 * 判断输入文本是否包含中文字符。
 * @param {unknown} input - 原始输入。
 * @returns {boolean} 是否包含中文。
 */
function containsChinese(input) {
  return HAS_CHINESE_REGEX.test(String(input || ''))
}

/**
 * 规范化搜索文本。
 * @param {unknown} input - 原始输入。
 * @returns {string} 去首尾空白后的文本。
 */
function normalizeSearchText(input) {
  return String(input || '').trim()
}

/**
 * 提取文本中的连续中文片段。
 * @param {unknown} input - 原始输入。
 * @returns {string[]} 中文片段列表。
 */
function extractChineseRuns(input) {
  const text = normalizeSearchText(input)
  if (!text) return []
  const matches = text.match(CHINESE_RUN_REGEX)
  return Array.isArray(matches) ? matches.map((item) => item.trim()).filter(Boolean) : []
}

/**
 * 对中文片段生成滑窗词项。
 * @param {unknown} input - 原始输入。
 * @param {number} [maxTermLength=2] - 最大词长。
 * @returns {string[]} 中文词项列表。
 */
function generateChineseTerms(input, maxTermLength = 2) {
  const runs = extractChineseRuns(input)
  const terms = new Set()

  for (const run of runs) {
    const chars = Array.from(run)
    for (let start = 0; start < chars.length; start += 1) {
      for (let len = 1; len <= maxTermLength; len += 1) {
        const term = chars.slice(start, start + len).join('')
        if (term && term.length === len) {
          terms.add(term)
        }
      }
    }
  }

  return Array.from(terms)
}

/** 英文单词（≥2 字母，小写去重）与连续数字串（含 1 位） */
/**
 * 提取英文词和连续数字词项。
 * @param {unknown} input - 原始输入。
 * @returns {string[]} 词项列表。
 */
function extractEnglishWordAndDigitTerms(input) {
  const s = String(input || '')
  const terms = new Set()
  for (const m of s.matchAll(/[a-zA-Z]{2,}/g)) {
    terms.add(m[0].toLowerCase())
  }
  for (const m of s.matchAll(/[0-9]+/g)) {
    terms.add(m[0])
  }
  return Array.from(terms)
}

/** 写入 media_search_terms：中文 1～2 字滑窗 + 英文词 + 连续数字 */
/**
 * 生成可写入 media_search_terms 的词项。
 * @param {unknown} input - 原始输入。
 * @returns {string[]} 去重后的词项列表。
 */
function generateMediaSearchTerms(input) {
  const terms = new Set()
  for (const t of generateChineseTerms(input, 2)) {
    terms.add(t)
  }
  for (const t of extractEnglishWordAndDigitTerms(input)) {
    terms.add(t)
  }
  return Array.from(terms)
}

/**
 * 将字段集合转换为 media_search_terms 行数据。
 * @param {{mediaId:number,userId:number,fields:Record<string, string>,updatedAt?:number}} payload - 构建参数。
 * @returns {Array<{mediaId:number,userId:number,fieldType:string,term:string,termLen:number,updatedAt:number}>} 词项行数据。
 */
function buildMediaSearchTermRows({ mediaId, userId, fields, updatedAt = Date.now() }) {
  const rows = []

  for (const [fieldType, value] of Object.entries(fields || {})) {
    const terms = generateMediaSearchTerms(value)
    for (const term of terms) {
      rows.push({
        mediaId,
        userId,
        fieldType,
        term,
        termLen: Array.from(term).length,
        updatedAt
      })
    }
  }

  return rows
}

// 合并进 media_search.caption_search_terms（jieba）的字段：仅图片理解相关 + 转写（OCR 仅存 ocr_text，检索走 LIKE）
const FIELD_KEYS_FOR_SEARCH_TERMS = ['description', 'keywords', 'subject_tags', 'action_tags', 'scene_tags', 'transcript']

/**
 * 合并多字段 → jieba 搜索模式分词后写入 caption_search_terms（不含 OCR）
 * @param {Record<string, string>} fields - 可参与分词的字段集合。
 * @returns {string|null} 空格拼接后的分词文本。
 */
function buildSearchTermsFromFields(fields) {
  const seen = new Set()
  const tokens = []
  for (const key of FIELD_KEYS_FOR_SEARCH_TERMS) {
    const v = fields && fields[key]
    if (typeof v !== 'string' || !v.trim()) continue
    for (const tok of segmentFieldForSearchTerms(v)) {
      if (!tok) continue
      const dedupeKey = /^[\x00-\x7f]+$/.test(tok) ? tok : tok
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      tokens.push(tok)
    }
  }
  return tokens.length > 0 ? tokens.join(' ') : null
}

/** 中文按字计、英文按词计，用于搜索 residual 长短分支（如 ≤2 / ≥3 单位） */
/**
 * 计算搜索片段长度单位（中文按字，英文数字按词）。
 * @param {unknown} segment - 待计算片段。
 * @returns {number} 长度单位数。
 */
function segmentLengthUnits(segment) {
  const s = String(segment || '').trim()
  if (!s) return 0
  const cjk = s.match(CHINESE_CHARS_GLOBAL_REGEX)
  const cjkCount = cjk ? cjk.length : 0
  const rest = s.replace(CHINESE_CHARS_GLOBAL_REGEX, ' ')
  const words = rest.trim().match(/[a-zA-Z0-9]+/g)
  const wordCount = words ? words.length : 0
  return cjkCount + wordCount
}

module.exports = {
  buildMediaSearchTermRows,
  buildSearchTermsFromFields,
  containsChinese,
  segmentLengthUnits
}
