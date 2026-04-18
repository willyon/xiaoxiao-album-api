/*
 * @Description: 智能搜索「应用层排序结果」内存缓存（与 DB 索引解耦，供 searchService 与 mediaModel 失效用）
 */
const crypto = require('crypto')

const SEARCH_RANK_CACHE_TTL_MS = 60 * 1000
const SEARCH_RANK_CACHE_MAX = 20
const cache = new Map()

/**
 * 清理过期缓存并维持容量上限。
 * @param {number} [now=Date.now()] - 当前时间戳。
 * @returns {void} 无返回值。
 */
function pruneSearchRankCache(now = Date.now()) {
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k)
  }
  while (cache.size > SEARCH_RANK_CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

/**
 * 生成排序缓存键。
 * @param {{
 * userId?: number|string,
 * normalizedQuery?: string,
 * whereConditions?: string[],
 * whereParams?: Array<string|number>,
 * baseFilters?: object,
 * filterOptions?: object,
 * scopeConditions?: string[],
 * scopeParams?: Array<string|number>
 * }} [payload={}] - 键构建参数。
 * @returns {string} SHA256 缓存键。
 */
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

/**
 * 读取搜索排序缓存（命中后刷新 LRU）。
 * @param {string} key - 缓存键。
 * @returns {{rankedIds:any[],stats:object,expiresAt:number}|null} 缓存项或 null。
 */
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

/**
 * 写入搜索排序缓存。
 * @param {string} key - 缓存键。
 * @param {{rankedIds:any[],stats:object}} value - 缓存内容。
 * @returns {void} 无返回值。
 */
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
/**
 * 清空全部搜索排序缓存。
 * @returns {void} 无返回值。
 */
function clearSearchRankCache() {
  cache.clear()
}

module.exports = {
  makeSearchRankCacheKey,
  getSearchRankCache,
  setSearchRankCache,
  clearSearchRankCache
}
