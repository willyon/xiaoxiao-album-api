/*
 * @Description: 省级 / 地区级名称（label + aliases），与逆地理 province 或地点键一致
 * 目前仅「台湾」；后续可扩展大陆各省等。
 */

module.exports = [
  /** 逆地理常只有省无市时地点键落在「台湾」 */
  { label: '台湾', aliases: ['台湾省', 'Taiwan', 'TW', 'Formosa'] }
]
