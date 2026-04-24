/**
 * DBSCAN 落库前：若两簇之间**最近**一对脸（跨簇）的余弦距离足够小，则并查集合并为一人。
 * 单一路径即可覆盖「每簇很散、质心远、但桥脸很近」的情况，避免再维护一套质心阈值。
 */
const logger = require('../../utils/logger')

function l2Unit(v) {
  const dim = v.length
  const out = new Array(dim)
  let n = 0
  for (let i = 0; i < dim; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1e-12
  for (let i = 0; i < dim; i++) out[i] = v[i] / n
  return out
}

function cosineDistanceUnit(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return 1 - dot
}

function minCrossClusterUnitPairDistance(unitA, unitB) {
  let minD = Infinity
  for (const a of unitA) {
    for (const b of unitB) {
      const d = cosineDistanceUnit(a, b)
      if (d < minD) minD = d
    }
  }
  return minD
}

/**
 * @param {Array} clusterData
 * @param {Array} clustersForThumbnails
 * @param {Array<{id:number, embedding:number[]}>} faceEmbeddings
 * @param {{ maxMinPairCosineDistance: number, userId: number|string }} opts
 *        maxMinPairCosineDistance ≤ 0 表示关闭合并
 */
function mergeAutoClustersAfterDbscan(clusterData, clustersForThumbnails, faceEmbeddings, opts) {
  const { maxMinPairCosineDistance, userId } = opts
  if (!clusterData.length || maxMinPairCosineDistance <= 0) {
    const distinct = new Set(clusterData.map((r) => r.clusterId))
    return {
      clusterData,
      clustersForThumbnails,
      mergeGroupCount: 0,
      beforeClusterCount: distinct.size,
      afterClusterCount: distinct.size
    }
  }

  const idToEmb = new Map(faceEmbeddings.map((fe) => [fe.id, fe.embedding]))
  const byCluster = new Map()
  for (const row of clusterData) {
    const raw = idToEmb.get(row.faceEmbeddingId)
    if (!raw) continue
    if (!byCluster.has(row.clusterId)) byCluster.set(row.clusterId, [])
    byCluster.get(row.clusterId).push(l2Unit(raw))
  }

  const clusterIds = [...byCluster.keys()].sort((a, b) => a - b)
  if (clusterIds.length <= 1) {
    return {
      clusterData,
      clustersForThumbnails,
      mergeGroupCount: 0,
      beforeClusterCount: clusterIds.length,
      afterClusterCount: clusterIds.length
    }
  }

  const parent = new Map()
  for (const id of clusterIds) parent.set(id, id)
  function find(x) {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)))
    return parent.get(x)
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (let i = 0; i < clusterIds.length; i++) {
    for (let j = i + 1; j < clusterIds.length; j++) {
      const a = clusterIds[i]
      const b = clusterIds[j]
      const d = minCrossClusterUnitPairDistance(byCluster.get(a), byCluster.get(b))
      if (d <= maxMinPairCosineDistance) union(a, b)
    }
  }

  const byRoot = new Map()
  for (const id of clusterIds) {
    const r = find(id)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(id)
  }
  const remap = new Map()
  for (const ids of byRoot.values()) {
    const canon = Math.min(...ids)
    for (const id of ids) remap.set(id, canon)
  }

  const beforeClusterCount = clusterIds.length
  const afterClusterCount = new Set(remap.values()).size
  const mergeGroupCount = beforeClusterCount - afterClusterCount

  if (mergeGroupCount > 0) {
    logger.info({
      message: `DBSCAN 后簇合并(跨簇最近脸对): ${beforeClusterCount} 簇 → ${afterClusterCount} 簇，合并 ${mergeGroupCount} 组`,
      details: { userId, maxMinPairCosineDistance, mergeGroupCount }
    })
  }

  const newData = clusterData.map((row) => ({
    ...row,
    clusterId: remap.get(row.clusterId) ?? row.clusterId
  }))

  const thumbMap = new Map()
  for (const t of clustersForThumbnails) {
    const cid = remap.get(t.cluster_id) ?? t.cluster_id
    const existing = thumbMap.get(cid) || []
    existing.push(...(t.face_indices || []))
    thumbMap.set(cid, existing)
  }
  const newThumbs = [...thumbMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cluster_id, indices]) => ({
      cluster_id,
      face_indices: [...new Set(indices)].sort((x, y) => x - y)
    }))

  return {
    clusterData: newData,
    clustersForThumbnails: newThumbs,
    mergeGroupCount,
    beforeClusterCount,
    afterClusterCount
  }
}

module.exports = {
  mergeAutoClustersAfterDbscan
}
