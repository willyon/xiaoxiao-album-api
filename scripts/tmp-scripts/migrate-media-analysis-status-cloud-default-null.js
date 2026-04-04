/*
 * 迁移：去掉 media.analysis_status_cloud 的列级 DEFAULT（历史 ADD COLUMN 常为 DEFAULT 'pending'），
 * 使新建行在未写该列时为 SQL NULL，与 initTableModel / insertMedia 约定一致。
 *
 * - 若列不存在：ADD COLUMN analysis_status_cloud TEXT（无 DEFAULT）
 * - 若列存在且 PRAGMA table_info 中 dflt_value 已为 NULL：跳过
 * - 若列存在且仍有 DEFAULT：通过 sqlite_master 的 CREATE TABLE 打补丁 → media_new → 复制 → 换表 → 重建索引
 *
 * 用法（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-media-analysis-status-cloud-default-null.js
 *
 * 建议先备份 database；可重复执行（已无时无操作）。
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name=?").get(name) != null;
}

function getCloudColumnInfo() {
  const rows = db.prepare("PRAGMA table_info(media)").all();
  return rows.find((c) => c.name === "analysis_status_cloud") || null;
}

/**
 * 从 sqlite_master 的 CREATE TABLE 语句中移除 analysis_status_cloud 的 DEFAULT 子句，并改名为 media_new。
 * @returns {string|null} 新 CREATE SQL；无法识别或无需修改时返回 null
 */
function buildMediaNewCreateSql(originalCreateSql) {
  if (!originalCreateSql || typeof originalCreateSql !== "string") return null;

  const patterns = [
    /\banalysis_status_cloud\s+TEXT\s+DEFAULT\s+'pending'/gi,
    /\banalysis_status_cloud\s+TEXT\s+DEFAULT\s+"pending"/gi,
    /\banalysis_status_cloud\s+TEXT\s+DEFAULT\s+\(NULL\)/gi,
  ];

  let body = originalCreateSql;
  let changed = false;
  for (const re of patterns) {
    const next = body.replace(re, "analysis_status_cloud TEXT");
    if (next !== body) {
      body = next;
      changed = true;
      break;
    }
  }

  // 兜底：任意 DEFAULT …（单 token，避免误伤复杂表达式）
  if (!changed) {
    const loose = body.replace(/\banalysis_status_cloud\s+TEXT\s+DEFAULT\s+[^,)]+/gi, "analysis_status_cloud TEXT");
    if (loose !== body) {
      body = loose;
      changed = true;
    }
  }

  if (!changed) return null;

  return body.replace(/^CREATE TABLE\s+"?media"?\s*\(/i, "CREATE TABLE media_new (");
}

function rebuildMediaTable() {
  const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get();
  if (!tableRow?.sql) {
    throw new Error("无法读取 media 表的 CREATE TABLE 语句");
  }

  const createMediaNewSql = buildMediaNewCreateSql(tableRow.sql);
  if (!createMediaNewSql) {
    throw new Error(
      "sqlite_master 中的 CREATE TABLE 无法自动去除 analysis_status_cloud 的 DEFAULT，请检查列定义或手工迁移",
    );
  }

  const cols = db.prepare("PRAGMA table_info(media)").all();
  const colNames = cols.map((c) => c.name);
  const insertCols = colNames.map(quoteIdent).join(", ");
  const insertSql = `INSERT INTO media_new (${insertCols}) SELECT ${insertCols} FROM media`;

  const indexRows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL")
    .all();

  console.log("开始重建 media 表：去除 analysis_status_cloud 的 DEFAULT …");

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
    console.log("✅ 已完成：analysis_status_cloud 无列级 DEFAULT，新建行省略该列即为 NULL");
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

  const cloud = getCloudColumnInfo();

  if (!cloud) {
    db.prepare("ALTER TABLE media ADD COLUMN analysis_status_cloud TEXT").run();
    console.log("✅ 已新增列 media.analysis_status_cloud TEXT（无 DEFAULT）");
    return;
  }

  if (cloud.dflt_value == null || cloud.dflt_value === "") {
    console.log("ℹ️ media.analysis_status_cloud 已无列级 DEFAULT，跳过");
    return;
  }

  console.log(`ℹ️ 检测到 analysis_status_cloud 的 DEFAULT=${JSON.stringify(cloud.dflt_value)}，执行重建 …`);
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

module.exports = { migrate };
