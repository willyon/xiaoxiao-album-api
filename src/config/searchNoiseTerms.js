/*
 * 检索噪声词表（原 embeddingLexicalGate 内联 Set），独立为 JSON 便于维护与 diff。
 */
const fs = require('fs')
const path = require('path')

const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'searchNoiseTerms.json'), 'utf8'))
if (!Array.isArray(list)) {
  throw new Error('searchNoiseTerms.json must be a JSON array of strings')
}

const SEARCH_NOISE_TERMS = new Set(list)

module.exports = { SEARCH_NOISE_TERMS }
