/*
 * @Description: 时间信号词配置
 */

module.exports = [
  { label: '今天', type: 'relative_day', aliases: ['今日'] },
  { label: '昨天', type: 'relative_day', aliases: ['昨日'] },
  { label: '前天', type: 'relative_day', aliases: [] },
  { label: '今年', type: 'relative_year', aliases: [] },
  { label: '去年', type: 'relative_year', aliases: [] },
  { label: '前年', type: 'relative_year', aliases: [] },
  { label: '本月', type: 'relative_month', aliases: ['这个月'] },
  { label: '上个月', type: 'relative_month', aliases: [] },
  // 单独出现的「N 月」按当年该月解析（named_month）；「去年六月」等由 queryTimeParser 正则优先匹配
  { label: '一月', type: 'named_month', month: 1, aliases: ['1月', '01月', '一月份', '1月份', '01月份'] },
  { label: '二月', type: 'named_month', month: 2, aliases: ['2月', '02月', '二月份', '2月份', '02月份'] },
  { label: '三月', type: 'named_month', month: 3, aliases: ['3月', '03月', '三月份', '3月份', '03月份'] },
  { label: '四月', type: 'named_month', month: 4, aliases: ['4月', '04月', '四月份', '4月份', '04月份'] },
  { label: '五月', type: 'named_month', month: 5, aliases: ['5月', '05月', '五月份', '5月份', '05月份'] },
  { label: '六月', type: 'named_month', month: 6, aliases: ['6月', '06月', '六月份', '6月份', '06月份'] },
  { label: '七月', type: 'named_month', month: 7, aliases: ['7月', '07月', '七月份', '7月份', '07月份'] },
  { label: '八月', type: 'named_month', month: 8, aliases: ['8月', '08月', '八月份', '8月份', '08月份'] },
  { label: '九月', type: 'named_month', month: 9, aliases: ['9月', '09月', '九月份', '9月份', '09月份'] },
  { label: '十月', type: 'named_month', month: 10, aliases: ['10月', '十月份', '10月份'] },
  { label: '十一月', type: 'named_month', month: 11, aliases: ['11月', '十一月份', '11月份'] },
  { label: '十二月', type: 'named_month', month: 12, aliases: ['12月', '十二月份', '12月份'] },
  { label: '最近', type: 'recent', aliases: ['近来'] },
  { label: '这周', type: 'relative_week', aliases: ['本周', '这星期', '本星期'] },
  { label: '上周', type: 'relative_week', aliases: ['上星期'] },
  { label: '本周末', type: 'weekend', aliases: ['这周末', '这星期周末', '本星期周末'] },
  { label: '上周末', type: 'weekend', aliases: ['上星期周末'] },
  { label: '最近几天', type: 'recent', aliases: ['近几天', '这几天'] },
  { label: '春天', type: 'season', aliases: ['春季'] },
  { label: '夏天', type: 'season', aliases: ['夏季'] },
  { label: '秋天', type: 'season', aliases: ['秋季'] },
  { label: '冬天', type: 'season', aliases: ['冬季'] }
]
