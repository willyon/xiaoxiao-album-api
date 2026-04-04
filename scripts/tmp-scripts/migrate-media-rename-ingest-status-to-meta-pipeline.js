/*
 * 将 media.ingest_status 重命名为 meta_pipeline_status（SQLite ALTER RENAME COLUMN）。
 * 适用于：枚举已是 pending/running/success/failed，仅列名未改动的库。
 *
 * 若仍存在旧枚举或旧列名 ingest_status 且需一并整理，请用：
 *   node scripts/tmp-scripts/migrate-media-ingest-status-unify-enums.js
 *
 * 用法（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-media-rename-ingest-status-to-meta-pipeline.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const cols = db.prepare("PRAGMA table_info(media)").all();
  const names = new Set(cols.map((c) => c.name));
  if (names.has("meta_pipeline_status")) {
    console.log("已存在 meta_pipeline_status，跳过");
    return;
  }
  if (!names.has("ingest_status")) {
    console.log("不存在 ingest_status，跳过");
    return;
  }
  db.prepare("ALTER TABLE media RENAME COLUMN ingest_status TO meta_pipeline_status").run();
  console.log("✅ 已将 ingest_status 重命名为 meta_pipeline_status");
}

migrate();
