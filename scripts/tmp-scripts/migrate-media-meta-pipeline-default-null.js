/*
 * 迁移：meta_pipeline_status 与 initTableModel 对齐
 * - 去掉 DEFAULT 'pending'、CHECK 中的 pending / running；合法非空值仅 success | failed
 * - 将 'pending' / 'running' 行更新为 NULL
 * - 必要时重建 media 表
 *
 * 用法（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-media-meta-pipeline-default-null.js
 *
 * 可重复执行；建议先备份 database。
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

const META_COL_NEW =
  "meta_pipeline_status TEXT CHECK (meta_pipeline_status IS NULL OR meta_pipeline_status IN ('success','failed'))";

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name=?").get(name) != null;
}

function getMetaColumnInfo() {
  const rows = db.prepare("PRAGMA table_info(media)").all();
  return rows.find((c) => c.name === "meta_pipeline_status") || null;
}

function isMetaPipelineSchemaTerminalOnly(sql) {
  return (
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IS\s+NULL\s+OR\s+meta_pipeline_status\s+IN\s*\(\s*'success'\s*,\s*'failed'\s*\)\s*\)/i.test(
      sql,
    ) ||
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IS\s+NULL\s+OR\s+meta_pipeline_status\s+IN\s*\(\s*'failed'\s*,\s*'success'\s*\)\s*\)/i.test(
      sql,
    )
  );
}

/** @returns {string|null} 新 CREATE SQL；已符合目标或无法识别时返回 null */
function buildMediaNewCreateSql(originalCreateSql) {
  if (!originalCreateSql || typeof originalCreateSql !== "string") return null;
  if (!originalCreateSql.includes("meta_pipeline_status")) return null;

  let body = originalCreateSql;
  const original = body;

  const fullPatterns = [
    /\bmeta_pipeline_status\s+TEXT\s+DEFAULT\s+'pending'\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\(\s*'pending'\s*,\s*'running'\s*,\s*'success'\s*,\s*'failed'\s*\)\s*\)/gi,
    /\bmeta_pipeline_status\s+TEXT\s+DEFAULT\s+'pending'\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\(\s*'running'\s*,\s*'success'\s*,\s*'failed'\s*,\s*'pending'\s*\)\s*\)/gi,
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\(\s*'pending'\s*,\s*'running'\s*,\s*'success'\s*,\s*'failed'\s*\)\s*\)/gi,
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\(\s*'running'\s*,\s*'success'\s*,\s*'failed'\s*,\s*'pending'\s*\)\s*\)/gi,
  ];
  for (const re of fullPatterns) {
    body = body.replace(re, META_COL_NEW);
  }

  body = body.replace(/\bmeta_pipeline_status\s+TEXT\s+DEFAULT\s+'pending'/gi, "meta_pipeline_status TEXT");
  body = body.replace(/\bmeta_pipeline_status\s+TEXT\s+DEFAULT\s+"pending"/gi, "meta_pipeline_status TEXT");

  body = body.replace(
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\([^)]*'pending'[^)]*\)\s*\)/gi,
    META_COL_NEW,
  );

  body = body.replace(
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IS\s+NULL\s+OR\s+meta_pipeline_status\s+IN\s*\([^)]+\)\s*\)/gi,
    (full) => (/'running'/.test(full) || /'pending'/.test(full) ? META_COL_NEW : full),
  );

  body = body.replace(
    /\bmeta_pipeline_status\s+TEXT\s+CHECK\s*\(\s*meta_pipeline_status\s+IN\s*\([^)]*'running'[^)]*\)\s*\)/gi,
    META_COL_NEW,
  );

  if (body === original) {
    if (isMetaPipelineSchemaTerminalOnly(original)) {
      return null;
    }
    return null;
  }

  return body.replace(/^CREATE TABLE\s+"?media"?\s*\(/i, "CREATE TABLE media_new (");
}

function metaColumnSlice(sql) {
  const idx = sql.indexOf("meta_pipeline_status");
  if (idx < 0) return "";
  return sql.slice(idx, idx + 400);
}

function metaColumnSliceImpliesPending(sql) {
  return metaColumnSlice(sql).includes("'pending'");
}

function metaColumnSliceImpliesRunningToken(sql) {
  return metaColumnSlice(sql).includes("'running'");
}

function rebuildMediaTable() {
  const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get();
  if (!tableRow?.sql) {
    throw new Error("无法读取 media 表的 CREATE TABLE 语句");
  }

  const createMediaNewSql = buildMediaNewCreateSql(tableRow.sql);
  if (!createMediaNewSql) {
    if (metaColumnSliceImpliesPending(tableRow.sql)) {
      throw new Error(
        "sqlite_master 中 meta_pipeline_status 仍含 pending，但无法自动改写 CREATE TABLE，请手工迁移",
      );
    }
    if (metaColumnSliceImpliesRunningToken(tableRow.sql) && !isMetaPipelineSchemaTerminalOnly(tableRow.sql)) {
      throw new Error(
        "sqlite_master 中 meta_pipeline_status 仍含 running，但无法自动改写 CREATE TABLE，请手工迁移",
      );
    }
    throw new Error("无法生成 media_new 的 CREATE TABLE，请检查列定义");
  }

  const cols = db.prepare("PRAGMA table_info(media)").all();
  const colNames = cols.map((c) => c.name);
  const insertCols = colNames.map(quoteIdent).join(", ");
  const insertSql = `INSERT INTO media_new (${insertCols}) SELECT ${insertCols} FROM media`;

  const indexRows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL")
    .all();

  console.log("开始重建 media 表：更新 meta_pipeline_status 列定义 …");

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
    console.log("✅ 已完成：meta_pipeline_status 仅为 NULL | success | failed（无 pending/running 枚举）");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function migrate() {
  if (!tableExists("media")) {
    console.log("media 表不存在，跳过");
    return;
  }

  const metaCol = getMetaColumnInfo();
  if (!metaCol) {
    console.log("media 无 meta_pipeline_status 列，跳过");
    return;
  }

  const pendingRows = db.prepare("SELECT COUNT(*) AS n FROM media WHERE meta_pipeline_status = 'pending'").get();
  const np = pendingRows?.n ?? 0;
  if (np > 0) {
    const r = db.prepare("UPDATE media SET meta_pipeline_status = NULL WHERE meta_pipeline_status = 'pending'").run();
    console.log(`ℹ️ 已将 ${r.changes} 行 meta_pipeline_status 从 'pending' 更新为 NULL`);
  }

  const runningRows = db.prepare("SELECT COUNT(*) AS n FROM media WHERE meta_pipeline_status = 'running'").get();
  const nr = runningRows?.n ?? 0;
  if (nr > 0) {
    const r = db.prepare("UPDATE media SET meta_pipeline_status = NULL WHERE meta_pipeline_status = 'running'").run();
    console.log(`ℹ️ 已将 ${r.changes} 行 meta_pipeline_status 从 'running' 更新为 NULL`);
  }

  const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get();
  const createSql = tableRow?.sql || "";

  const newCreate = buildMediaNewCreateSql(createSql);
  if (!newCreate) {
    const dflt = metaCol.dflt_value;
    if (dflt != null && String(dflt).toLowerCase().includes("pending")) {
      console.log("ℹ️ PRAGMA 仍显示列 DEFAULT 含 pending，执行重建 …");
      rebuildMediaTable();
      return;
    }
    if (metaColumnSliceImpliesPending(createSql)) {
      console.log("ℹ️ CREATE TABLE 中 meta_pipeline_status 仍含 pending，执行重建 …");
      rebuildMediaTable();
      return;
    }
    if (metaColumnSliceImpliesRunningToken(createSql) && !isMetaPipelineSchemaTerminalOnly(createSql)) {
      console.log("ℹ️ CREATE TABLE 中 meta_pipeline_status 仍含 'running'，执行重建 …");
      rebuildMediaTable();
      return;
    }
    console.log("ℹ️ meta_pipeline_status 列定义已符合目标，跳过重建");
    return;
  }

  rebuildMediaTable();
}

if (require.main === module) {
  const dbPath = db.name || path.join(process.cwd(), "database.db");
  console.log(`迁移目标数据库：${dbPath}`);
  try {
    migrate();
  } catch (e) {
    console.error("❌ 迁移失败：", e.message || e);
    process.exitCode = 1;
  }
}

module.exports = { migrate, buildMediaNewCreateSql };
