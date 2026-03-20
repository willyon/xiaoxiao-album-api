/*
 * @Description: 查询语义匹配通用工具
 */

function normalizeSemanticText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function uniqueTerms(terms = []) {
  const seen = new Set();
  const output = [];
  for (const term of terms) {
    const value = typeof term === "string" ? term.trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function normalizeQueryText(query) {
  return normalizeSemanticText(query);
}

function buildGroupTerms(entry) {
  return uniqueTerms([entry.label, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeSemanticText));
}

function buildAliasCandidates(dictionary) {
  const candidates = [];
  for (const entry of dictionary) {
    const terms = buildGroupTerms(entry);
    for (const term of terms) {
      candidates.push({
        label: entry.label,
        term,
        terms,
        type: entry.type,
        filterValues: entry.filterValues,
        ...(entry.month != null ? { month: entry.month } : {}),
      });
    }
  }
  return candidates.sort((a, b) => b.term.length - a.term.length || a.label.localeCompare(b.label, "zh-Hans-CN"));
}

function isOverlapping(range, occupiedRanges) {
  return occupiedRanges.some((item) => !(range.end <= item.start || range.start >= item.end));
}

function sortRanges(ranges = []) {
  return [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
}

function collectMatches(normalizedQuery, dictionary, options = {}) {
  if (!normalizedQuery) {
    return [];
  }

  const { includeMatchedRanges = true } = options;
  const occupiedRanges = [];
  const groupedMatches = new Map();
  for (const candidate of buildAliasCandidates(dictionary)) {
    let searchFrom = 0;
    while (searchFrom < normalizedQuery.length) {
      const start = normalizedQuery.indexOf(candidate.term, searchFrom);
      if (start < 0) break;
      const range = { start, end: start + candidate.term.length };
      searchFrom = start + 1;
      if (isOverlapping(range, occupiedRanges)) {
        continue;
      }
      occupiedRanges.push(range);
      const existing = groupedMatches.get(candidate.label) || {
        label: candidate.label,
        terms: candidate.terms,
        matchedAliases: [],
        matchedRanges: [],
        type: candidate.type,
        filterValues: candidate.filterValues,
        ...(candidate.month != null ? { month: candidate.month } : {}),
      };
      existing.matchedAliases.push(candidate.term);
      if (includeMatchedRanges) {
        existing.matchedRanges.push(range);
      }
      groupedMatches.set(candidate.label, existing);
    }
  }
  return Array.from(groupedMatches.values()).map((group) => ({
    ...group,
    matchedAliases: uniqueTerms(group.matchedAliases),
    matchedRanges: sortRanges(group.matchedRanges),
    primaryMatch: group.matchedAliases[0] || group.label,
  }));
}

function collectResidualQuery(normalizedQuery, ranges) {
  if (!normalizedQuery) {
    return { residualQuery: "", residualSegments: [] };
  }

  const sortedRanges = sortRanges(ranges);
  let cursor = 0;
  const residualSegments = [];
  for (const range of sortedRanges) {
    if (cursor < range.start) {
      residualSegments.push(normalizedQuery.slice(cursor, range.start));
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < normalizedQuery.length) {
    residualSegments.push(normalizedQuery.slice(cursor));
  }

  return {
    residualQuery: residualSegments.join(""),
    residualSegments: residualSegments.filter(Boolean),
  };
}

module.exports = {
  normalizeSemanticText,
  uniqueTerms,
  normalizeQueryText,
  buildGroupTerms,
  buildAliasCandidates,
  isOverlapping,
  sortRanges,
  collectMatches,
  collectResidualQuery,
};
