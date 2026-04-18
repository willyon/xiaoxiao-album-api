/*
 * @Author: zhangshouchang
 * @Date: 2025-07-26 22:05:33
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-09 21:04:17
 * @Description: File description
 */
const zhMessages = require('./zh')
const enMessages = require('./en')

/**
 * 按语言与错误码获取国际化文案，并替换占位参数。
 * @param {string} messageCode - 消息码。
 * @param {'zh'|'en'} [lang='zh'] - 语言标识。
 * @param {Record<string, string|number>} [params] - 占位参数。
 * @returns {string} 最终文案。
 */
function getI18nMessage(messageCode, lang = 'zh', params) {
  const safeParams = params || {}
  const messages = lang === 'zh' ? zhMessages : enMessages
  let messageTemplate = messages[messageCode] || 'Unknown response'

  // 替换模板中的 {xxx}
  Object.entries(safeParams).forEach(([key, value]) => {
    messageTemplate = messageTemplate.replace(new RegExp(`{${key}}`, 'g'), value)
  })

  return messageTemplate
}

module.exports = getI18nMessage
