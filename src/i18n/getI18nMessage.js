/*
 * @Author: zhangshouchang
 * @Date: 2025-07-26 22:05:33
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-09 21:04:17
 * @Description: File description
 */
const zhMessages = require('./zh')
const enMessages = require('./en')

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
