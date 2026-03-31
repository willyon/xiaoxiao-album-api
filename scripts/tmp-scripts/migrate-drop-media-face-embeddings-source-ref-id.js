/*
 * 迁移：从 media_face_embeddings 删除 source_ref_id 列。
 * - 唯一约束改为 (media_id, source_type, face_index)
 * - 可重跑：列不存在则跳过
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-drop-media-face-embeddings-source-ref-id.js
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
  if (!tableExists("media_face_embeddings")) {
    console.log("media_face_embeddings 表不存在，跳过");
    return;
  }

  const cols = columnNames("media_face_embeddings");
  if (!cols.includes("source_ref_id")) {
    console.log("media_face_embeddings.source_ref_id 不存在，跳过");
    return;
  }

  const before = db.prepare("SELECT COUNT(*) AS n FROM media_face_embeddings").get();
  console.log(`迁移前 media_face_embeddings 行数: ${before.n}`);

  const tx = db.transaction(() => {
    db.prepare("DROP TABLE IF EXISTS media_face_embeddings_new").run();

    db.prepare(`
      CREATE TABLE media_face_embeddings_new (
        id INTEGER PRIMARY KEY,
        media_id INTEGER NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'image',
        face_index INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        age INTEGER,
        gender TEXT,
        expression TEXT,
        confidence REAL,
        quality_score REAL,
        bbox TEXT,
        pose TEXT,
        ignored_for_clustering BOOLEAN DEFAULT FALSE,
        face_thumbnail_storage_key TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
        UNIQUE (media_id, source_type, face_index)
      );
    `).run();

    db.prepare(`
      INSERT INTO media_face_embeddings_new (
        id, media_id, source_type, face_index, embedding, age, gender, expression,
        confidence, quality_score, bbox, pose, ignored_for_clustering, face_thumbnail_storage_key, created_at
      )
      SELECT
        id, media_id, source_type, face_index, embedding, age, gender, expression,
        confidence, quality_score, bbox, pose, ignored_for_clustering, face_thumbnail_storage_key, created_at
      FROM media_face_embeddings;
    `).run();

    db.prepare("DROP TABLE media_face_embeddings").run();
    db.prepare("ALTER TABLE media_face_embeddings_new RENAME TO media_face_embeddings").run();

    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_media_id ON media_face_embeddings(media_id);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_age ON media_face_embeddings(age);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_gender ON media_face_embeddings(gender);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_expression ON media_face_embeddings(expression);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_ignored ON media_face_embeddings(ignored_for_clustering);").run();
  });

  tx();

  const after = db.prepare("SELECT COUNT(*) AS n FROM media_face_embeddings").get();
  console.log(`迁移后 media_face_embeddings 行数: ${after.n}`);
  console.log("✅ 已删除 media_face_embeddings.source_ref_id，唯一键为 (media_id, source_type, face_index)");
}

migrate();
