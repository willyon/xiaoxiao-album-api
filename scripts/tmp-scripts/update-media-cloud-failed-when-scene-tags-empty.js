/*
 * 将 ai_scene_tags_json 为「空」的 media 行，把 analysis_status_cloud 置为 failed。
 *
 * 「空」的定义：列为 SQL NULL，或去掉首尾空白后长度为 0（不含 JSON 的 []，避免误伤合法空数组）。
 *
 * 使用方式（在 xiaoxiao-project-service 根目录执行）：
 *   node scripts/tmp-scripts/update-media-cloud-failed-when-scene-tags-empty.js
 *   node scripts/tmp-scripts/update-media-cloud-failed-when-scene-tags-empty.js --dry-run
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

const dryRun = process.argv.includes("--dry-run");

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function main() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").get()) {
    console.log("ℹ️ media 表不存在，退出。");
    return;
  }

  const cols = columnNames("media");
  if (!cols.includes("ai_scene_tags_json")) {
    console.error("❌ 缺少列 ai_scene_tags_json，退出。");
    process.exitCode = 1;
    return;
  }
  if (!cols.includes("analysis_status_cloud")) {
    console.error("❌ 缺少列 analysis_status_cloud，退出。");
    process.exitCode = 1;
    return;
  }

  const countStmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM media
    WHERE (ai_scene_tags_json IS NULL OR TRIM(ai_scene_tags_json) = '')
  `);
  const total = countStmt.get().n;

  const wouldChangeStmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM media
    WHERE (ai_scene_tags_json IS NULL OR TRIM(ai_scene_tags_json) = '')
      AND IFNULL(analysis_status_cloud, '') != 'failed'
  `);
  const wouldChange = wouldChangeStmt.get().n;

  console.log(`ℹ️ 满足「场景标签为空」条件的行数: ${total}`);
  console.log(`ℹ️ 其中 analysis_status_cloud 尚非 failed 的行数: ${wouldChange}`);

  if (dryRun) {
    console.log("🔍 --dry-run：未写入数据库。");
    return;
  }

  db.exec("BEGIN TRANSACTION");
  try {
    const info = db
      .prepare(
        `
        UPDATE media
        SET analysis_status_cloud = 'failed'
        WHERE (ai_scene_tags_json IS NULL OR TRIM(ai_scene_tags_json) = '')
          AND IFNULL(analysis_status_cloud, '') != 'failed'
      `,
      )
      .run();
    db.exec("COMMIT");
    console.log(`✅ 已更新 ${info.changes} 行：analysis_status_cloud = 'failed'`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 更新失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

main();
