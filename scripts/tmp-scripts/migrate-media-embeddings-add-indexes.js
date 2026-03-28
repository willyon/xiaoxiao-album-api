/**
 * 为 media_embeddings 增加文本向量召回所需索引。
 *
 * @Usage:
 *   node scripts/tmp-scripts/migrate-media-embeddings-add-indexes.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_embeddings'").get();
  if (!table) {
    console.log("media_embeddings 表不存在，跳过");
    return;
  }

  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_embeddings_source_type ON media_embeddings(source_type);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_embeddings_media_source ON media_embeddings(media_id, source_type);").run();

  console.log("✅ media_embeddings 索引已就绪");
}

migrate();
