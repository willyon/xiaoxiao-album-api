/**
 * 分析两个 face cluster（同一 user）的 embedding 与元数据，用于判断「同一人被拆成两簇」
 * 更可能由哪类原因导致（与默认 DBSCAN eps、跨簇/簇内距离、来源与质量等对照）。
 *
 * 用法（在 xiaoxiao-album-api 根目录）:
 *   node -r dotenv/config scripts/tmp-scripts/analyze-two-face-clusters.js <userId> <clusterA> <clusterB>
 * 示例:
 *   node -r dotenv/config scripts/tmp-scripts/analyze-two-face-clusters.js 1 23 363
 *
 * 若不传 userId，则自动查找「同时包含两个 cluster_id」的 user_id（仅唯一时成功）。
 *
 * 说明：会读取本地 database.db，与生产库不一致时请自行换库后重跑。
 */

const path = require('path')

const projectRoot = path.resolve(__dirname, '..', '..')
process.chdir(projectRoot)

const { db } = require(path.join(projectRoot, 'src', 'db'))

const DEFAULT_EPS = Number(process.env.FACE_CLUSTERING_THRESHOLD || 0.45)
const INCREMENTAL_MIN_SIM = Number(process.env.FACE_INCREMENTAL_ASSIGN_MIN_SIMILARITY || 0.75)

const argv = process.argv.slice(2)
let userId
let cA
let cB

if (argv.length >= 3) {
  userId = parseInt(argv[0], 10)
  cA = parseInt(argv[1], 10)
  cB = parseInt(argv[2], 10)
  if (!Number.isFinite(userId)) {
    console.error('第一个参数 userId 须为有效整数；若只分析两聚类、不需指定用户，可省略 userId 只传两个 clusterId。')
    process.exit(1)
  }
} else if (argv.length === 2) {
  cA = parseInt(argv[0], 10)
  cB = parseInt(argv[1], 10)
} else {
  console.error('用法: node -r dotenv/config scripts/tmp-scripts/analyze-two-face-clusters.js [userId] <clusterA> <clusterB>')
  process.exit(1)
}

if (![cA, cB].every((n) => Number.isFinite(n))) {
  console.error('clusterId 须为数字。')
  process.exit(1)
}

if (cA === cB) {
  console.error('请传入两个不同的 clusterId。')
  process.exit(1)
}

function parseEmbedding(row) {
  if (row == null) return null
  const s = row.toString('utf8')
  return JSON.parse(s)
}

function l2Norm(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s) || 1e-12
}

function normalizeInPlace(a) {
  const n = l2Norm(a)
  for (let i = 0; i < a.length; i++) a[i] /= n
  return a
}

function copyNormalized(emb) {
  const a = emb.slice()
  return normalizeInPlace(a)
}

function cosineSimilarityUnit(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

function cosineDistanceUnit(a, b) {
  return 1 - cosineSimilarityUnit(a, b)
}

function centroid(vectors) {
  if (!vectors.length) return null
  const d = vectors[0].length
  const sum = new Array(d).fill(0)
  for (const v of vectors) {
    for (let i = 0; i < d; i++) sum[i] += v[i]
  }
  for (let i = 0; i < d; i++) sum[i] /= vectors.length
  return normalizeInPlace(sum)
}

function minMaxMean(arr) {
  if (!arr.length) return { min: null, max: null, mean: null }
  let min = arr[0]
  let max = arr[0]
  let t = 0
  for (const x of arr) {
    if (x < min) min = x
    if (x > max) max = x
    t += x
  }
  return { min, max, mean: t / arr.length }
}

function allPairwiseMinCosineDistance(normList) {
  if (normList.length < 2) return { min: null, max: null, count: 0 }
  const n = normList.length
  let minD = Infinity
  let maxD = -Infinity
  let c = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistanceUnit(normList[i], normList[j])
      if (d < minD) minD = d
      if (d > maxD) maxD = d
      c++
    }
  }
  return { min: minD, max: maxD, count: c }
}

function crossClusterMinMaxAvg(normA, normB) {
  const dists = []
  let minD = Infinity
  let maxD = -Infinity
  for (const a of normA) {
    for (const b of normB) {
      const d = cosineDistanceUnit(a, b)
      dists.push(d)
      if (d < minD) minD = d
      if (d > maxD) maxD = d
    }
  }
  const mean = dists.reduce((s, x) => s + x, 0) / dists.length
  return { min: minD, max: maxD, mean, pairCount: dists.length }
}

function findAutoUserId(id1, id2) {
  const sql = `
    SELECT user_id, COUNT(DISTINCT cluster_id) AS cc
    FROM face_clusters
    WHERE cluster_id IN (?, ?)
    GROUP BY user_id
    HAVING cc = 2
  `
  return db.prepare(sql).all(id1, id2)
}

function tryParsePose(poseStr) {
  if (poseStr == null || String(poseStr).trim() === '') return null
  try {
    const p = JSON.parse(poseStr)
    const y = p.yaw
    if (typeof y === 'number' && !Number.isNaN(y)) return { yaw: y, raw: p }
  } catch (_) {}
  return null
}

if (!Number.isFinite(userId)) {
  const rows = findAutoUserId(cA, cB)
  if (rows.length === 0) {
    console.error(
      `未找到同时包含 cluster_id ${cA} 与 ${cB} 的 user。请显式传入 userId：\n` +
        `  node -r dotenv/config scripts/tmp-scripts/analyze-two-face-clusters.js <userId> ${cA} ${cB}`,
    )
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(
      `存在多个 user 同时拥有这两个聚类: ${rows.map((r) => r.user_id).join(', ')}。请显式指定 userId。`,
    )
    process.exit(1)
  }
  userId = rows[0].user_id
  console.log(`[自动] userId = ${userId}\n`)
}

// ----- 取两簇行 -----
const faceSql = `
  SELECT
    fc.cluster_id,
    fe.id AS face_embedding_id,
    fe.media_id,
    fe.source_type,
    fe.face_index,
    fe.quality_score,
    fe.pose,
    fe.confidence,
    fe.ignored_for_clustering,
    fe.embedding
  FROM face_clusters fc
  INNER JOIN media_face_embeddings fe ON fe.id = fc.face_embedding_id
  INNER JOIN media m ON m.id = fe.media_id
  WHERE fc.user_id = ?
    AND fc.cluster_id IN (?, ?)
    AND m.deleted_at IS NULL
  ORDER BY fc.cluster_id, fe.id
`

const rows = db.prepare(faceSql).all(userId, cA, cB)
if (rows.length === 0) {
  console.error(`无数据：userId=${userId} 下不存在 cluster_id 为 ${cA} 或 ${cB} 的有效人脸行（或 media 已删）。`)
  process.exit(1)
}

const byCluster = new Map()
for (const r of rows) {
  if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, [])
  byCluster.get(r.cluster_id).push(r)
}

if (!byCluster.has(cA) || !byCluster.has(cB)) {
  console.error(
    `userId=${userId} 下只找到部分聚类: 有 ${[...byCluster.keys()].join(', ')}，需要 ${cA} 与 ${cB} 同时存在。`,
  )
  process.exit(1)
}

const listA = byCluster.get(cA)
const listB = byCluster.get(cB)
const normA = listA.map((r) => copyNormalized(parseEmbedding(r.embedding)))
const normB = listB.map((r) => copyNormalized(parseEmbedding(r.embedding)))

// ----- 表内代表向量 -----
let repMap = new Map()
try {
  const repRows = db
    .prepare(
      `SELECT cluster_id, representative_embedding FROM face_cluster_representatives WHERE user_id = ? AND cluster_id IN (?, ?)`,
    )
    .all(userId, cA, cB)
  for (const r of repRows) {
    repMap.set(r.cluster_id, copyNormalized(parseEmbedding(r.representative_embedding)))
  }
} catch (e) {
  console.warn('（警告）读 face_cluster_representatives 失败，跳过表内存档代表向量', e.message)
  repMap = new Map()
}

const centA = centroid(listA.map((r) => parseEmbedding(r.embedding).slice()))
const centB = centroid(listB.map((r) => parseEmbedding(r.embedding).slice()))
const distCent = cosineDistanceUnit(centA, centB)

const intraA = allPairwiseMinCosineDistance(normA)
const intraB = allPairwiseMinCosineDistance(normB)
const cross = crossClusterMinMaxAvg(normA, normB)

const minSimIfCross = 1 - cross.min

// ----- 元数据统计 -----
function summarizeMeta(list, label) {
  const source = {}
  const qualities = []
  const yaws = []
  const ignored = { true: 0, false: 0 }
  for (const r of list) {
    source[r.source_type] = (source[r.source_type] || 0) + 1
    if (r.quality_score != null) qualities.push(r.quality_score)
    const pose = tryParsePose(r.pose)
    if (pose) yaws.push(pose.yaw)
    if (r.ignored_for_clustering) ignored.true++
    else ignored.false++
  }
  return { label, source, quality: minMaxMean(qualities), yaws: minMaxMean(yaws), ignored }
}

const metaA = summarizeMeta(listA, cA)
const metaB = summarizeMeta(listB, cB)

// ----- 输出 -----
console.log('========== 两簇聚类分析 ==========')
console.log(`userId: ${userId}   cluster: ${cA} vs ${cB}`)
console.log(
  `参考阈值（与 AI 服务默认对齐，以环境变量为准）: FACE_CLUSTERING_THRESHOLD(eps, 余弦距离)=${DEFAULT_EPS}；增量归属最小相似度=${INCREMENTAL_MIN_SIM}`,
)
console.log('')
console.log('--- 规模 ---')
console.log(`  簇 ${cA}: ${listA.length} 张脸`)
console.log(`  簇 ${cB}: ${listB.length} 张脸`)
console.log('')

console.log('--- 余弦距离 (L2 归一化后, distance = 1 - cosineSim)，值越小越像 ---')
console.log(
  `  两簇质心之间:     ${distCent.toFixed(4)}  (对应质心余弦相似度 ${(1 - distCent).toFixed(4)})`,
)
if (repMap.has(cA) && repMap.has(cB)) {
  const dRep = cosineDistanceUnit(repMap.get(cA), repMap.get(cB))
  console.log(
    `  表内代表向量之间: ${dRep.toFixed(4)}  (face_cluster_representatives, 与质心可能略有不同)`,
  )
}
console.log(
  `  跨簇 最小距离:   ${cross.min.toFixed(4)}  ← 全库任取一脸在 23、一脸在 363 的「最像」一对（距离仍为此算法下的最小值）`,
)
console.log(`  跨簇 最大距离:   ${cross.max.toFixed(4)}`)
console.log(`  跨簇 平均距离:   ${cross.mean.toFixed(4)}  （共 ${cross.pairCount} 对）`)
console.log('')

console.log('--- 簇内（抽样全体两两，仅 n 较小时可完全枚举）---')
if (intraA.min != null) {
  console.log(
    `  簇 ${cA} 内: min ${intraA.min.toFixed(4)}, max ${intraA.max.toFixed(4)} (${intraA.count} 对)`,
  )
} else {
  console.log(`  簇 ${cA} 内: 单点，无簇内对`)
}
if (intraB.min != null) {
  console.log(
    `  簇 ${cB} 内: min ${intraB.min.toFixed(4)}, max ${intraB.max.toFixed(4)} (${intraB.count} 对)`,
  )
} else {
  console.log(`  簇 ${cB} 内: 单点，无簇内对`)
}
console.log('')

function fmtMeta(m) {
  const st = Object.entries(m.source)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const q = m.quality
  return [
    `  来源: ${st || '—'}`,
    `  quality_score: min ${q.min != null ? q.min.toFixed(3) : '—'} max ${q.max != null ? q.max.toFixed(3) : '—'} mean ${q.mean != null ? q.mean.toFixed(3) : '—'}`,
    m.yaws.mean != null
      ? `  yaw(°): min ${m.yaws.min.toFixed(1)} max ${m.yaws.max.toFixed(1)} mean ${m.yaws.mean.toFixed(1)}`
      : '  yaw: 无或不可解析',
    `  ignored_for_clustering: true=${m.ignored.true} false=${m.ignored.false}`,
  ].join('\n')
}

console.log('--- 元数据对比 ---')
console.log(`簇 ${cA}:\n${fmtMeta(metaA)}`)
console.log(`簇 ${cB}:\n${fmtMeta(metaB)}`)
console.log('')

// ----- 结论文本 -----
console.log('========== 结论（基于当前数据与上面阈值）==========')
const lines = []
if (cross.min > DEFAULT_EPS) {
  lines.push(
    `1) **DBSCAN/eps 机制（两岛无桥）+ 默认阈值过严（相对这两簇而言）**`,
    `   跨簇任意一对的最小余弦距离为 ${cross.min.toFixed(4)}，大于当前 eps=${DEFAULT_EPS}。`,
    `   在同一次全量余弦-DBSCAN 下，这足以解释为何算法无法把两簇并在一起（分属不同密度连通片）。`,
    `   若「最小跨簇距离 > eps」成立，也与我方先前归纳的「阈值与 DBSCAN 不合并两岛」一致。`,
  )
} else {
  lines.push(
    `1) 跨簇最小余弦距离 ${cross.min.toFixed(4)} ≤ eps=${DEFAULT_EPS}：在**仅**看这两堆向量的两两距离时，存在「近」的跨簇对。`,
    `   若两簇确为**同一次**全量聚类且中间未手改/增量-only，理论上 DBSCAN 应把能一步连上 eps 的放进同一类；请核对是否分次跑聚类、是否曾经手动合并/拆分、或两簇中某些脸为后来增量写入。`,
  )
}

lines.push('')

if (minSimIfCross < INCREMENTAL_MIN_SIM) {
  lines.push(
    `2) **增量归属阈值**：最像的跨簇一对，余弦相似度 ${minSimIfCross.toFixed(4)} < 增量默认 ${INCREMENTAL_MIN_SIM}。`,
    `   新脸若只走「和代表向量比相似度再并入」这条路径，可能长期进不了另一簇，容易在后续全量时仍呈多簇。`,
  )
} else {
  lines.push(
    `2) 增量归属：最像跨簇对相似度 ${minSimIfCross.toFixed(4)} ≥ ${INCREMENTAL_MIN_SIM}，`,
    `   若新脸与代表质心/代表向量能接近到该水平，**单独**用增量阈值**不一定**是拆簇主因。`,
  )
}

const stA = new Set(Object.keys(metaA.source))
const stB = new Set(Object.keys(metaB.source))
const onlyA = [...stA].filter((x) => !stB.has(x))
const onlyB = [...stB].filter((x) => !stA.has(x))
if (onlyA.length || onlyB.length) {
  lines.push(
    ``,
    `3) **来源/场景差异（特征分布）**：两簇的 source_type 分布不完全一致（仅出现在一边: ${
      [...onlyA, ...onlyB].join(', ') || '无'
    }），可能放大类内方差、拉开跨簇质心。`,
  )
} else {
  lines.push(``, `3) 两簇 source_type 分布无「仅单边出现」的类别，拆簇更主要由距离阈值/历史聚类过程解释。`)
}

const dYaw =
  metaA.yaws.mean != null && metaB.yaws.mean != null
    ? Math.abs(metaA.yaws.mean - metaB.yaws.mean)
    : null
if (dYaw != null && dYaw > 25) {
  lines.push(``, `4) 侧脸/姿态：两簇 mean yaw 相差约 ${dYaw.toFixed(1)}°，易拉高簇间余弦距，和「同一身份、embedding 多峰」类原因一致。`)
} else {
  lines.push(``, `4) 侧脸/姿态：两簇 mean yaw 差异${dYaw != null ? `约 ${dYaw.toFixed(1)}°` : '不可比'}，未必是主因。`)
}

console.log(lines.join('\n'))
console.log('')
process.exit(0)
