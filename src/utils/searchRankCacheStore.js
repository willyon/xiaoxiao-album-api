/*
 * @Description: 智能搜索「应用层排序结果」内存缓存（与 DB 索引解耦，供 searchService 与 mediaModel 失效用）
 */
const crypto = require('crypto')

const SEARCH_RANK_CACHE_TTL_MS = 60 * 1000
const SEARCH_RANK_CACHE_MAX = 20
const cache = new Map()

function pruneSearchRankCache(now = Date.now()) {
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k)
  }
  while (cache.size > SEARCH_RANK_CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

function makeSearchRankCacheKey({
  userId,
  normalizedQuery,
  whereConditions,
  whereParams,
  baseFilters,
  filterOptions,
  scopeConditions,
  scopeParams
} = {}) {
  const payload = JSON.stringify({
    u: userId,
    q: normalizedQuery,
    wc: whereConditions,
    wp: whereParams,
    bf: baseFilters ?? null,
    /** 与 `searchService.buildFilterQueryParts` / mergeFilters 后的筛选一致：含 clusterId 等，避免与 bf 重复遗漏 */
    fo: filterOptions ?? null,
    sc: scopeConditions ?? null,
    sp: scopeParams ?? null
  })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function getSearchRankCache(key) {
  pruneSearchRankCache()
  const entry = cache.get(key)
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function setSearchRankCache(key, { rankedIds, stats }) {
  pruneSearchRankCache()
  if (cache.has(key)) cache.delete(key)
  cache.set(key, {
    rankedIds,
    stats,
    expiresAt: Date.now() + SEARCH_RANK_CACHE_TTL_MS
  })
  while (cache.size > SEARCH_RANK_CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

/** 媒体增删或搜索文档变更后调用，避免排序缓存与 FTS / term 索引不一致 */
function clearSearchRankCache() {
  cache.clear()
}

module.exports = {
  makeSearchRankCacheKey,
  getSearchRankCache,
  setSearchRankCache,
  clearSearchRankCache
}
