/**
 * 一次性维护：将「在 face_clusters 中 representative_type=0 的人脸行」的
 * media_face_embeddings.face_thumbnail_storage_key 置为 NULL（不删对象存储文件）。
 * 1/2 代表行不碰。
 *
 * 使用（在 xiaoxiao-album-api 根目录、需已配置 database.db 或同类路径）:
 *   node -r dotenv/config scripts/tmp-scripts/clear-rep0-face-thumbnail-keys.js
 * 仅某用户:
 *   node -r dotenv/config scripts/tmp-scripts/clear-rep0-face-thumbnail-keys.js 123
 */

const path = require('path')

const projectRoot = path.resolve(__dirname, '..', '..')
process.chdir(projectRoot)

const { db } = require(path.join(projectRoot, 'src', 'db'))

const userIdArg = process.argv[2]
const userId = userIdArg != null && String(userIdArg).trim() !== '' ? parseInt(userIdArg, 10) : null
if (userId != null && !Number.isFinite(userId)) {
  console.error('用法: 可选一个数字 userId 作为第一个参数。')
  process.exit(1)
}

const subquery = `
  SELECT fe.id
  FROM media_face_embeddings fe
  INNER JOIN face_clusters fc ON fe.id = fc.face_embedding_id
  INNER JOIN media m ON fe.media_id = m.id
  WHERE m.deleted_at IS NULL
    AND fc.representative_type = 0
    AND (fe.face_thumbnail_storage_key IS NOT NULL AND fe.face_thumbnail_storage_key != '')
    ${userId != null ? 'AND m.user_id = ?' : ''}
`

try {
  const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM media_face_embeddings WHERE id IN (${subquery})`)
  const before = (userId != null ? countStmt.get(userId) : countStmt.get()).c

  if (before === 0) {
    console.log('无需要清理的行。')
    process.exit(0)
  }

  const updateSql = `
    UPDATE media_face_embeddings
    SET face_thumbnail_storage_key = NULL
    WHERE id IN (${subquery})
  `
  const run = userId != null ? db.prepare(updateSql).run(userId) : db.prepare(updateSql).run()

  console.log(
    `已清除 representative_type=0 人脸行的 face_thumbnail_storage_key ${run.changes} 条` +
      (userId != null ? `（仅 userId=${userId}）` : '（全库）') +
      '。对象存储中的旧小图未删除，需另行清理时可按 key 列表处理。'
  )
  process.exit(0)
} catch (err) {
  console.error('执行失败:', err.message)
  process.exit(1)
}
