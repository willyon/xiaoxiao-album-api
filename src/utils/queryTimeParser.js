/*
 * @Description: 查询时间解析工具
 */
const { TIME_SIGNAL_TERMS } = require("../config/searchSemanticDictionary");
const {
  collectMatches,
  isOverlapping,
} = require("./querySemanticMatcher");

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatMonthKey(year, month) {
  return `${year}-${pad2(month)}`;
}

function shiftMonth(year, month, offset) {
  const date = new Date(year, month - 1 + offset, 1);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // 以周一为一周开始
  const day = d.getDay(); // 0=周日
  const diff = day === 0 ? -6 : (1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function parseChineseMonthToken(fragment) {
  const t = String(fragment || "")
    .replace(/份/g, "")
    .replace(/月$/, "")
    .trim();
  const cn = { 十二: 12, 十一: 11, 十: 10, 九: 9, 八: 8, 七: 7, 六: 6, 五: 5, 四: 4, 三: 3, 二: 2, 一: 1 };
  for (const k of Object.keys(cn).sort((a, b) => b.length - a.length)) {
    if (t === k) return cn[k];
  }
  return null;
}

function buildTimeFilter(type, payload) {
  switch (type) {
    case "absolute_year":
      return { timeDimension: "year", selectedTimeValues: [String(payload.year)] };
    case "absolute_month":
      return { timeDimension: "month", selectedTimeValues: [formatMonthKey(payload.year, payload.month)] };
    case "named_month": {
      const m = Number(payload.month);
      if (!Number.isFinite(m) || m < 1 || m > 12) return null;
      const year = new Date().getFullYear();
      return { timeDimension: "month", selectedTimeValues: [formatMonthKey(year, m)] };
    }
    case "absolute_date": {
      const dateKey = formatDateKey(payload.year, payload.month, payload.day);
      return { customDateRange: [dateKey, dateKey] };
    }
    case "relative_year": {
      const currentYear = new Date().getFullYear();
      return { timeDimension: "year", selectedTimeValues: [String(currentYear + payload.offset)] };
    }
    case "relative_month": {
      const today = new Date();
      const shifted = shiftMonth(today.getFullYear(), today.getMonth() + 1, payload.offset);
      return { timeDimension: "month", selectedTimeValues: [formatMonthKey(shifted.year, shifted.month)] };
    }
    case "relative_day": {
      const date = new Date();
      date.setDate(date.getDate() + payload.offset);
      const dateKey = formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
      return { customDateRange: [dateKey, dateKey] };
    }
    case "recent": {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (payload.days || 30));
      return {
        customDateRange: [
          formatDateKey(start.getFullYear(), start.getMonth() + 1, start.getDate()),
          formatDateKey(end.getFullYear(), end.getMonth() + 1, end.getDate()),
        ],
      };
    }
    case "relative_week": {
      const today = new Date();
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      base.setDate(base.getDate() + (payload.offset || 0) * 7);
      const start = startOfWeek(base);
      const end = endOfWeek(base);
      return {
        customDateRange: [
          formatDateKey(start.getFullYear(), start.getMonth() + 1, start.getDate()),
          formatDateKey(end.getFullYear(), end.getMonth() + 1, end.getDate()),
        ],
      };
    }
    case "weekend": {
      const today = new Date();
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      base.setDate(base.getDate() + (payload.offset || 0) * 7);
      const weekStart = startOfWeek(base);
      const sat = new Date(weekStart);
      sat.setDate(sat.getDate() + 5);
      const sun = new Date(weekStart);
      sun.setDate(sun.getDate() + 6);
      return {
        customDateRange: [
          formatDateKey(sat.getFullYear(), sat.getMonth() + 1, sat.getDate()),
          formatDateKey(sun.getFullYear(), sun.getMonth() + 1, sun.getDate()),
        ],
      };
    }
    case "season": {
      // 与 buildSearchQueryParts 中 timeDimension===season 一致：按月份 12/1/2、3–5… 过滤任意年份，
      // 勿用「当年12月～次年2月」的 customDateRange（在冬春之交会漏掉当年 1–2 月；在 3–11 月则变成未来日期，导致零结果）。
      const season = String(payload?.season || "");
      if (!season) return null;
      return {
        timeDimension: "season",
        selectedTimeValues: [season],
      };
    }
    default:
      return null;
  }
}

function createTimeSignal({ label, type, matchedText, start, end, payload }) {
  return {
    label,
    type,
    terms: [matchedText],
    matchedAliases: [matchedText],
    matchedRanges: [{ start, end }],
    primaryMatch: matchedText,
    resolvedFilter: buildTimeFilter(type, payload),
  };
}

function collectRegexMatches(normalizedQuery, patterns) {
  const matches = [];
  for (const { regex, mapMatch } of patterns) {
    let match;
    while ((match = regex.exec(normalizedQuery)) !== null) {
      const mapped = mapMatch(match);
      if (!mapped) continue;
      matches.push(mapped);
    }
  }
  return matches;
}

function collectExplicitTimeSignals(normalizedQuery) {
  const cnMonthWithOptionalFen = "(?:十二|十一|十|[一二三四五六七八九])月(?:份)?";
  const relativeYearPatterns = [
    {
      regex: new RegExp(`(前年|去年|今年)(${cnMonthWithOptionalFen})`, "g"),
      mapMatch: (match) => {
        const offsetMap = { 前年: -2, 去年: -1, 今年: 0 };
        const year = new Date().getFullYear() + offsetMap[match[1]];
        const monthNum = parseChineseMonthToken(match[2]);
        if (!monthNum) return null;
        return createTimeSignal({
          label: `${match[1]}${match[2]}`,
          type: "absolute_month",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year, month: monthNum },
        });
      },
    },
    {
      regex: /(前年|去年|今年)(\d{1,2})月(\d{1,2})[日号]?/g,
      mapMatch: (match) => {
        const offsetMap = { 前年: -2, 去年: -1, 今年: 0 };
        const year = new Date().getFullYear() + offsetMap[match[1]];
        const month = Number(match[2]);
        const day = Number(match[3]);
        return createTimeSignal({
          label: `${match[1]}${match[2]}月${match[3]}日`,
          type: "absolute_date",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year, month, day },
        });
      },
    },
    {
      regex: /(前年|去年|今年)(\d{1,2})月(?:份)?/g,
      mapMatch: (match) => {
        const offsetMap = { 前年: -2, 去年: -1, 今年: 0 };
        const year = new Date().getFullYear() + offsetMap[match[1]];
        const month = Number(match[2]);
        if (month < 1 || month > 12) return null;
        return createTimeSignal({
          label: `${match[1]}${match[2]}月`,
          type: "absolute_month",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year, month },
        });
      },
    },
  ];

  const absolutePatterns = [
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\p{L}\p{N}])/gu,
      mapMatch: (match) =>
        createTimeSignal({
          label: match[0],
          type: "absolute_date",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
        }),
    },
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})年(\d{1,2})月(\d{1,2})[日号]?(?![\p{L}\p{N}])/gu,
      mapMatch: (match) =>
        createTimeSignal({
          label: match[0],
          type: "absolute_date",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
        }),
    },
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})[-/.](\d{1,2})(?![-/.0-9\p{L}\p{N}])/gu,
      mapMatch: (match) =>
        createTimeSignal({
          label: match[0],
          type: "absolute_month",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year: Number(match[1]), month: Number(match[2]) },
        }),
    },
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})年(\d{1,2})月(?![\d\p{L}\p{N}])/gu,
      mapMatch: (match) =>
        createTimeSignal({
          label: match[0],
          type: "absolute_month",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year: Number(match[1]), month: Number(match[2]) },
        }),
    },
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})年?(?![-/.月日号\d\p{L}\p{N}])/gu,
      mapMatch: (match) => {
        const year = Number(match[1]);
        if (year < 1900 || year > 2100) return null;
        return createTimeSignal({
          label: match[0],
          type: "absolute_year",
          matchedText: match[0],
          start: match.index,
          end: match.index + match[0].length,
          payload: { year },
        });
      },
    },
  ];

  return [
    ...collectRegexMatches(normalizedQuery, relativeYearPatterns),
    ...collectRegexMatches(normalizedQuery, absolutePatterns),
  ];
}

function collectKeywordTimeSignals(normalizedQuery) {
  const groups = collectMatches(normalizedQuery, TIME_SIGNAL_TERMS);
  return groups.map((group) => ({
    ...group,
    resolvedFilter: buildTimeFilter(group.type, {
      offset:
        group.label === "今天" ? 0
          : group.label === "昨天" ? -1
            : group.label === "前天" ? -2
              : group.label === "今年" ? 0
                : group.label === "去年" ? -1
                  : group.label === "前年" ? -2
                    : group.label === "本月" ? 0
                      : group.label === "上个月" ? -1
                        : group.label === "这周" ? 0
                          : group.label === "上周" ? -1
                            : group.label === "本周末" ? 0
                              : group.label === "上周末" ? -1
                        : undefined,
      month: group.month,
      days: group.label === "最近" ? 30
        : group.label === "最近几天" ? 7
          : undefined,
      season:
        group.label === "春天" ? "spring"
          : group.label === "夏天" ? "summer"
            : group.label === "秋天" ? "autumn"
              : group.label === "冬天" ? "winter"
                : undefined,
    }),
  }));
}

function collectTimeSignals(normalizedQuery) {
  const occupiedRanges = [];
  const accepted = [];
  const explicitSignals = collectExplicitTimeSignals(normalizedQuery).sort(
    (a, b) => (b.primaryMatch || "").length - (a.primaryMatch || "").length || a.label.localeCompare(b.label, "zh-Hans-CN"),
  );

  for (const signal of explicitSignals) {
    const range = signal.matchedRanges[0];
    if (!range || isOverlapping(range, occupiedRanges)) continue;
    occupiedRanges.push(range);
    accepted.push(signal);
  }

  const keywordSignals = collectKeywordTimeSignals(normalizedQuery);
  for (const signal of keywordSignals) {
    const ranges = signal.matchedRanges || [];
    if (ranges.some((range) => isOverlapping(range, occupiedRanges))) continue;
    occupiedRanges.push(...ranges);
    accepted.push(signal);
  }

  return accepted.sort((a, b) => {
    const rangeA = a.matchedRanges?.[0];
    const rangeB = b.matchedRanges?.[0];
    return (rangeA?.start || 0) - (rangeB?.start || 0);
  });
}

function pickPrimaryTimeFilter(timeSignals) {
  const ranked = [...(timeSignals || [])].sort((a, b) => {
    const rank = (signal) => {
      if (signal.type === "absolute_date" || signal.type === "relative_day") return 4;
      if (signal.type === "weekend") return 4;
      if (signal.type === "relative_week") return 3;
      if (signal.type === "absolute_month" || signal.type === "relative_month" || signal.type === "named_month") return 3;
      if (signal.type === "absolute_year" || signal.type === "relative_year") return 2;
      if (signal.type === "recent") return 1;
      return 0;
    };
    return rank(b) - rank(a);
  });
  return ranked[0]?.resolvedFilter || null;
}

module.exports = {
  collectTimeSignals,
  pickPrimaryTimeFilter,
};
