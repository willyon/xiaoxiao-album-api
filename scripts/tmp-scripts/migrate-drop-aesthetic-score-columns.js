/**
 * 一次性迁移：删除审美分列 `aesthetic_score`（media、similar_group_members）。
 * 需 SQLite 3.35+（DROP COLUMN）。失败时可备份后执行 rebuild-database.js。
 *
 * 使用：在 xiaoxiao-album-api 根目录执行
 *   node scripts/deployment/migrate-drop-aesthetic-score-columns.js
 */

const path = require('path')

const projectRoot = path.resolve(__dirname, '..', '..')
process.chdir(projectRoot)

const { db } = require(path.join(projectRoot, 'src', 'db'))

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all()
  return rows.some((row) => row.name === columnName)
}

function dropColumn(tableName, columnName) {
  if (!hasColumn(tableName, columnName)) {
    console.log(`${tableName}.${columnName} 不存在，跳过。`)
    return
  }
  db.prepare(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`).run()
  console.log(`已删除 ${tableName}.${columnName}`)
}

try {
  // 成员表先删，避免心理依赖顺序；与 media 列无 FK 关联
  dropColumn('similar_group_members', 'aesthetic_score')
  dropColumn('media', 'aesthetic_score')

  const bad = db.pragma('foreign_key_check')
  if (bad && bad.length > 0) {
    console.error('外键检查未通过:', bad)
    process.exit(1)
  }

  console.log('迁移完成。')
  process.exit(0)
} catch (err) {
  console.error('迁移失败:', err.message)
  console.error('若本机 SQLite 不支持 DROP COLUMN，请备份后使用 node scripts/deployment/rebuild-database.js 全量重建。')
  process.exit(1)
}
