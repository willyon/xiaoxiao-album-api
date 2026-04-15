/**
 * 删除 face_clusters.is_representative（已由 representative_type 替代；应用层未再写入该列）
 *
 * 需要 SQLite 3.35+（支持 ALTER TABLE DROP COLUMN）。better-sqlite3 链接的 SQLite 需满足。
 *
 * 用法（在 xiaoxiao-project-service 目录）：
 *   node scripts/tmp-scripts/migrate-drop-face-clusters-is-representative.js
 */

const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
process.chdir(projectRoot);
require("dotenv").config({ path: path.join(projectRoot, ".env") });

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((c) => c.name === column);
}

function main() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='face_clusters'").get()) {
    console.log("ℹ️  无 face_clusters 表，跳过。");
    return;
  }

  if (!columnExists("face_clusters", "is_representative")) {
    console.log("✅ 列 is_representative 已不存在，跳过。");
    return;
  }

  const ver = db.prepare("SELECT sqlite_version() AS v").get();
  console.log("SQLite 版本:", ver?.v);

  try {
    db.prepare("ALTER TABLE face_clusters DROP COLUMN is_representative").run();
    console.log("✅ 已删除 face_clusters.is_representative");
  } catch (e) {
    console.error("❌ DROP COLUMN 失败（若版本 < 3.35 不支持）：", e.message);
    process.exit(1);
  }
}

main();
