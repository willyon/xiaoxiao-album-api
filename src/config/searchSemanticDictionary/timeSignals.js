/*
 * @Description: 时间信号词配置
 */

module.exports = [
  { label: "今天", type: "relative_day", aliases: ["今天", "今日"] },
  { label: "昨天", type: "relative_day", aliases: ["昨天", "昨日"] },
  { label: "前天", type: "relative_day", aliases: ["前天"] },
  { label: "今年", type: "relative_year", aliases: ["今年"] },
  { label: "去年", type: "relative_year", aliases: ["去年"] },
  { label: "前年", type: "relative_year", aliases: ["前年"] },
  { label: "本月", type: "relative_month", aliases: ["本月", "这个月"] },
  { label: "上个月", type: "relative_month", aliases: ["上个月"] },
  { label: "最近", type: "recent", aliases: ["最近", "近来"] },
  { label: "这周", type: "relative_week", aliases: ["这周", "本周", "这星期", "本星期"] },
  { label: "上周", type: "relative_week", aliases: ["上周", "上星期"] },
  { label: "本周末", type: "weekend", aliases: ["本周末", "这周末", "这星期周末", "本星期周末"] },
  { label: "上周末", type: "weekend", aliases: ["上周末", "上星期周末"] },
  { label: "最近几天", type: "recent", aliases: ["最近几天", "近几天", "这几天"] },
  { label: "春天", type: "season", aliases: ["春天", "春季"] },
  { label: "夏天", type: "season", aliases: ["夏天", "夏季"] },
  { label: "秋天", type: "season", aliases: ["秋天", "秋季"] },
  { label: "冬天", type: "season", aliases: ["冬天", "冬季"] },
];
