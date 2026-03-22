/*
 * 迁移：从 media_embeddings 表删除 model_id 列，唯一约束改为 (media_id, source_type)。
 * - 若同一 (media_id, source_type) 存在多行（历史不同 model_id），保留 id 最大的一行。
 * - 可重跑：列已不存在则跳过。
 * - 新库请直接用 initTableModel / rebuild-database 创建，无需本脚本。
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-media-embeddings-drop-model-id.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  if (!tableExists("media_embeddings")) {
    console.log("media_embeddings 表不存在，跳过");
    return;
  }

  const cols = columnNames("media_embeddings");
  if (!cols.includes("model_id")) {
    console.log("media_embeddings.model_id 不存在，跳过");
    return;
  }

  const before = db.prepare("SELECT COUNT(*) AS n FROM media_embeddings").get();
  console.log(`迁移前 media_embeddings 行数: ${before.n}`);

  const tx = db.transaction(() => {
    db.prepare("DROP TABLE IF EXISTS media_embeddings_new").run();

    db.prepare(`
      CREATE TABLE media_embeddings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_ref_id INTEGER,
        vector BLOB NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
        analysis_version TEXT,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
        UNIQUE (media_id, source_type)
      );
    `).run();

    db.prepare(`
      INSERT INTO media_embeddings_new (media_id, source_type, source_ref_id, vector, created_at, analysis_version)
      SELECT media_id, source_type, source_ref_id, vector, created_at, analysis_version
      FROM media_embeddings
      WHERE id IN (
        SELECT MAX(id) FROM media_embeddings GROUP BY media_id, source_type
      );
    `).run();

    db.prepare("DROP TABLE media_embeddings").run();
    db.prepare("ALTER TABLE media_embeddings_new RENAME TO media_embeddings").run();
  });

  tx();

  const after = db.prepare("SELECT COUNT(*) AS n FROM media_embeddings").get();
  console.log(`迁移后 media_embeddings 行数: ${after.n}`);
  console.log("✅ 已删除 media_embeddings.model_id，唯一键为 (media_id, source_type)");
}

migrate();
