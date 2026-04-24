/**
 * 一次性维护：将 face_clusters 中 is_user_assigned 全部视为「非手动」，改回自动聚类可参与全量重算。
 * 仅当你确认没有（或愿放弃）真正的「移脸/合并到他人」等手动锁定时使用。
 *
 * 用法（在 xiaoxiao-album-api 根目录）:
 *   node -r dotenv/config scripts/tmp-scripts/reset-face-user-assigned-to-auto.js <userId>
 *
 * 例:
 *   node -r dotenv/config scripts/tmp-scripts/reset-face-user-assigned-to-auto.js 1
 */

const path = require('path')

const projectRoot = path.resolve(__dirname, '..', '..')
process.chdir(projectRoot)

const { db } = require(path.join(projectRoot, 'src', 'db'))

const userIdArg = process.argv[2]
if (userIdArg == null || String(userIdArg).trim() === '') {
  console.error('用法: node -r dotenv/config scripts/tmp-scripts/reset-face-user-assigned-to-auto.js <userId>')
  process.exit(1)
}

const userId = parseInt(userIdArg, 10)
if (!Number.isFinite(userId)) {
  console.error('userId 须为数字')
  process.exit(1)
}

try {
  const before = db
    .prepare(
      `SELECT COUNT(*) AS c FROM face_clusters WHERE user_id = ? AND COALESCE(is_user_assigned, 0) = 1`
    )
    .get(userId).c

  if (before === 0) {
    console.log(`userId=${userId} 下无 is_user_assigned=1 行，无需更新。`)
    process.exit(0)
  }

  const run = db
    .prepare(
      `UPDATE face_clusters SET is_user_assigned = 0, updated_at = ? WHERE user_id = ? AND COALESCE(is_user_assigned, 0) = 1`
    )
    .run(Date.now(), userId)

  console.log(
    `已将 userId=${userId} 的 ${run.changes} 条 face_clusters 行改为自动（is_user_assigned=0）。` +
      `原标记为手动的有 ${before} 条。` +
      `请随后触发一次全量重聚（如再分析一张有脸的图，或你已有的调度）以便重新划簇。`
  )
  process.exit(0)
} catch (err) {
  console.error('执行失败:', err.message)
  if (/no such column/i.test(err.message)) {
    console.error('（若表无 is_user_assigned 列，需先按你们迁移加列。）')
  }
  process.exit(1)
}
