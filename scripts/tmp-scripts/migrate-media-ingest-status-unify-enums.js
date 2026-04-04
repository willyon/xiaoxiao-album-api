/*
 * 一次性迁移：统一 media 上「meta 流水线」状态列与枚举，并与 analysis_* 对齐。
 *
 * - 列名：ingest_status → meta_pipeline_status（若仍为 ingest_status，新表使用 meta_pipeline_status）
 * - processing → NULL，ready → success，NULL → success，pending → NULL（与当前 schema：仅 success | failed 为终态）
 * - CHECK：NULL | success | failed（无 DEFAULT）
 *
 * 通过 sqlite_master 的 CREATE TABLE 替换列定义、建 media_new、复制数据、换表、重建索引。
 *
 * 用法（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-media-ingest-status-unify-enums.js
 *
 * 若仅需将已统一枚举的 ingest_status 重命名为 meta_pipeline_status，可改用：
 *   node scripts/tmp-scripts/migrate-media-rename-ingest-status-to-meta-pipeline.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

const UNIFIED_META_COL =
  "meta_pipeline_status TEXT CHECK (meta_pipeline_status IS NULL OR meta_pipeline_status IN ('success','failed'))";

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function patchCreateSqlToMediaNew(sql) {
  if (!sql || typeof sql !== "string") {
    throw new Error("无法读取 media 表的 CREATE TABLE 语句");
  }
  const patterns = [
    /ingest_status\s+TEXT\s+DEFAULT\s+'pending'\s+CHECK\s*\(\s*ingest_status\s+IN\s*\([^)]+\)\s*\)\s*,/i,
    /meta_pipeline_status\s+TEXT\s+DEFAULT\s+'pending'\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\([^)]+\)\s*\)\s*,/i,
    /ingest_status\s+TEXT\s+DEFAULT\s+'pending'\s*,/i,
    /meta_pipeline_status\s+TEXT\s+DEFAULT\s+'pending'\s*,/i,
  ];
  let body = sql;
  let matched = false;
  for (const re of patterns) {
    if (re.test(body)) {
      body = body.replace(re, `${UNIFIED_META_COL},`);
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new Error("CREATE TABLE sql 中未找到 ingest_status / meta_pipeline_status 列定义，请检查 sqlite_master");
  }
  return body.replace(/^CREATE TABLE\s+"?media"?\s*\(/i, "CREATE TABLE media_new (");
}

function migrate() {
  const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get();
  if (!tableRow?.sql) {
    console.log("media 表不存在，跳过");
    return;
  }

  const cols = db.prepare("PRAGMA table_info(media)").all();
  const hasIngest = cols.some((c) => c.name === "ingest_status");
  const hasMeta = cols.some((c) => c.name === "meta_pipeline_status");
  if (!hasIngest && !hasMeta) {
    console.log("media 上无 ingest_status / meta_pipeline_status，跳过");
    return;
  }
  if (hasIngest && hasMeta) {
    throw new Error("media 表同时存在 ingest_status 与 meta_pipeline_status，请手工处理数据库");
  }

  const indexRows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL")
    .all();

  const createMediaNewSql = patchCreateSqlToMediaNew(tableRow.sql);
  const sourceCol = hasIngest ? "ingest_status" : "meta_pipeline_status";

  const insertCols = cols.map((c) => (c.name === "ingest_status" ? "meta_pipeline_status" : c.name));
  const selectParts = cols.map((c) => {
    if (c.name === "ingest_status" || c.name === "meta_pipeline_status") {
      return `CASE
      WHEN ${sourceCol} IS NULL THEN 'success'
      WHEN ${sourceCol} = 'pending' THEN NULL
      WHEN ${sourceCol} = 'ready' THEN 'success'
      WHEN ${sourceCol} = 'processing' THEN NULL
      ELSE ${sourceCol}
    END`;
    }
    return quoteIdent(c.name);
  });

  const insertSql = `INSERT INTO media_new (${insertCols.map(quoteIdent).join(", ")})
    SELECT ${selectParts.join(", ")} FROM media`;

  console.log("开始迁移：meta 流水线状态列 → meta_pipeline_status，并统一枚举 …");

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN TRANSACTION");
  try {
    db.prepare("DROP TABLE IF EXISTS media_new").run();
    db.exec(createMediaNewSql);
    db.prepare(insertSql).run();
    db.prepare("DROP TABLE media").run();
    db.prepare("ALTER TABLE media_new RENAME TO media").run();

    for (const row of indexRows) {
      if (row.sql) {
        db.exec(row.sql);
      }
    }

    db.exec("COMMIT");
    console.log("✅ 完成：meta_pipeline_status（NULL / success / failed）");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", err);
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

migrate();
