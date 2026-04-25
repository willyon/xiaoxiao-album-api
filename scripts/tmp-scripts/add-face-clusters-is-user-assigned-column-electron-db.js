/**
 * 一次性维护：为 Electron 本地数据库 face_clusters 补齐 is_user_assigned 列。
 *
 * 默认数据库路径：
 *   ~/Library/Application Support/xiaoxiao-album-app/database.db
 *
 * 用法（在 xiaoxiao-album-api 根目录）:
 *   node scripts/tmp-scripts/add-face-clusters-is-user-assigned-column-electron-db.js
 *   node scripts/tmp-scripts/add-face-clusters-is-user-assigned-column-electron-db.js "/path/to/database.db"
 */

const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const dbPathArg = process.argv[2]
const dbPath = dbPathArg
  ? path.resolve(dbPathArg)
  : path.join(os.homedir(), 'Library', 'Application Support', 'xiaoxiao-album-app', 'database.db')

let db
try {
  db = new Database(dbPath)
} catch (err) {
  console.error(`打开数据库失败: ${dbPath}`)
  console.error(err.message)
  process.exit(1)
}

try {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='face_clusters'")
    .get()
  if (!table) {
    console.error(`数据库中不存在 face_clusters 表: ${dbPath}`)
    process.exit(1)
  }

  const cols = db.prepare('PRAGMA table_info(face_clusters)').all()
  const hasColumn = cols.some((c) => c.name === 'is_user_assigned')
  if (hasColumn) {
    const nullCount = db
      .prepare('SELECT COUNT(*) AS c FROM face_clusters WHERE is_user_assigned IS NULL')
      .get().c
    if (nullCount > 0) {
      db.prepare('UPDATE face_clusters SET is_user_assigned = 0 WHERE is_user_assigned IS NULL').run()
      console.log(`已存在 is_user_assigned；补齐 NULL -> 0，影响 ${nullCount} 行。`)
    } else {
      console.log('is_user_assigned 列已存在，无需变更。')
    }
    process.exit(0)
  }

  db.prepare('ALTER TABLE face_clusters ADD COLUMN is_user_assigned INTEGER DEFAULT 0').run()
  const updated = db.prepare('UPDATE face_clusters SET is_user_assigned = 0 WHERE is_user_assigned IS NULL').run().changes
  console.log(`已添加列 is_user_assigned，并补齐 NULL -> 0（${updated} 行）。`)
  console.log(`数据库: ${dbPath}`)
} catch (err) {
  console.error('执行失败:', err.message)
  process.exit(1)
} finally {
  try {
    db.close()
  } catch {}
}
