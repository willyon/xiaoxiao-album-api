const { WORD_OR_CJK_REGEX } = require('./cjkRegex')

/**
 * 判断文本是否仅包含标点或空白。
 * @param {string} text - 待判断文本。
 * @returns {boolean} 是否仅标点/空白。
 */
function isOnlyPunctOrSpace(text) {
  return !text || !WORD_OR_CJK_REGEX.test(text)
}

module.exports = {
  isOnlyPunctOrSpace
}
