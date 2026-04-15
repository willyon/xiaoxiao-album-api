/*
 * @Description: 清理非用户核心数据（Redis、除 users 外的数据库表、storage-local 中图片/视频）
 * @Usage: node scripts/development/reset-non-user-data.js
 */
const fs = require('fs')
const path = require('path')

const scriptDir = path.dirname(__filename)
const projectRoot = path.resolve(scriptDir, '..', '..')
process.chdir(projectRoot)

require('dotenv').config()

const { db } = require(path.join(projectRoot, 'src', 'services', 'database'))
const { getRedisClient } = require(path.join(projectRoot, 'src', 'services', 'redisClient'))

const MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.m4v',
  '.3gp',
  '.mts',
  '.m2ts',
  '.ts',
  '.flv',
  '.wmv'
])

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

function getTablesExceptUsers() {
  const rows = db
    .prepare(
      `
      SELECT name
      FROM pragma_table_list
      WHERE schema = 'main'
        AND type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != 'users'
      ORDER BY name ASC
      `
    )
    .all()

  return rows.map((row) => row.name)
}

function clearDatabaseTablesExceptUsers() {
  console.log('\n[1/3] 清理数据库（保留 users）...')
  const tables = getTablesExceptUsers()
  if (tables.length === 0) {
    console.log('  ℹ️ 未发现可清理的数据表')
    return { tableCount: 0, deletedRows: 0 }
  }

  db.prepare('PRAGMA foreign_keys = OFF').run()

  let deletedRows = 0
  try {
    const runDelete = db.transaction(() => {
      for (const tableName of tables) {
        const safeName = quoteIdentifier(tableName)
        const before = db.prepare(`SELECT COUNT(*) AS c FROM ${safeName}`).get().c || 0
        db.prepare(`DELETE FROM ${safeName}`).run()
        deletedRows += before
        console.log(`  ✅ ${tableName}: 删除 ${before} 行`)
      }
    })

    runDelete()
  } finally {
    db.prepare('PRAGMA foreign_keys = ON').run()
  }

  console.log(`  🎉 数据库清理完成：${tables.length} 张表，约 ${deletedRows} 行`)
  return { tableCount: tables.length, deletedRows }
}

async function clearRedisAllKeys() {
  console.log('\n[2/3] 清理 Redis 全部缓存...')
  const redisClient = getRedisClient()

  try {
    await redisClient.ping()
    let cursor = '0'
    let totalDeleted = 0

    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', '*', 'COUNT', 500)
      cursor = nextCursor
      if (keys.length > 0) {
        // 优先使用 UNLINK，避免阻塞 Redis；旧版本自动回退 DEL
        if (typeof redisClient.unlink === 'function') {
          totalDeleted += await redisClient.unlink(...keys)
        } else {
          totalDeleted += await redisClient.del(...keys)
        }
      }
    } while (cursor !== '0')

    console.log(`  🎉 Redis 清理完成：删除 ${totalDeleted} 个 key`)
    return { deletedKeys: totalDeleted }
  } finally {
    await redisClient.quit().catch(() => {})
  }
}

function walkAndDeleteMediaFiles(rootDir) {
  let deletedFiles = 0
  let scannedFiles = 0

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      scannedFiles += 1
      const ext = path.extname(entry.name).toLowerCase()
      if (MEDIA_EXTENSIONS.has(ext)) {
        fs.unlinkSync(fullPath)
        deletedFiles += 1
      }
    }
  }

  walk(rootDir)
  return { scannedFiles, deletedFiles }
}

function clearLocalStorageMedia() {
  console.log('\n[3/3] 清理 storage-local 下图片与视频...')
  const localStorageDir = path.join(projectRoot, 'storage-local')

  if (!fs.existsSync(localStorageDir)) {
    console.log('  ℹ️ 未找到 storage-local 目录，跳过')
    return { scannedFiles: 0, deletedFiles: 0 }
  }

  const result = walkAndDeleteMediaFiles(localStorageDir)
  console.log(`  🎉 storage-local 清理完成：扫描 ${result.scannedFiles} 个文件，删除 ${result.deletedFiles} 个图片/视频文件`)
  return result
}

async function main() {
  console.log('==============================================')
  console.log('🧹 开始清理：Redis + DB(保留 users) + storage-local媒体')
  console.log('==============================================')

  const dbResult = clearDatabaseTablesExceptUsers()
  const redisResult = await clearRedisAllKeys()
  const storageResult = clearLocalStorageMedia()

  console.log('\n✅ 全部清理完成')
  console.log(`- 数据库: ${dbResult.tableCount} 张表，约 ${dbResult.deletedRows} 行`)
  console.log(`- Redis: ${redisResult.deletedKeys} 个 key`)
  console.log(`- storage-local: 删除 ${storageResult.deletedFiles} 个文件`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ 清理失败:', error)
    process.exit(1)
  })
