/*
 * @Description: 修复 face_clusters 外键指向，确保引用 media_face_embeddings
 * @Usage: node scripts/tmp-scripts/fix-face-clusters-fk-to-media.js
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

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((c) => c.name === column);
}

function getFaceClustersFkTarget() {
  if (!tableExists("face_clusters")) return null;
  const fks = db.prepare("PRAGMA foreign_key_list(face_clusters)").all();
  const target = fks.find((row) => row.from === "face_embedding_id");
  return target?.table || null;
}

function recreateFaceClustersWithMediaFk() {
  if (!tableExists("face_clusters")) {
    console.log("ℹ️  未找到 face_clusters，跳过修复。");
    return;
  }

  if (!tableExists("media_face_embeddings")) {
    throw new Error("未找到 media_face_embeddings，无法修复 face_clusters 外键。");
  }

  const hasIsRepresentative = columnExists("face_clusters", "is_representative"); // 仅用于从极旧表迁移时读源列
  const hasIsUserAssigned = columnExists("face_clusters", "is_user_assigned");
  const hasRepresentativeType = columnExists("face_clusters", "representative_type");

  const fkTarget = getFaceClustersFkTarget();
  if (fkTarget === "media_face_embeddings" && hasRepresentativeType) {
    console.log("✅ face_clusters 外键已指向 media_face_embeddings，且 representative_type 已存在，无需修复。");
    return;
  }

  const isUserAssignedExpr = hasIsUserAssigned ? "COALESCE(is_user_assigned, 0)" : "0";
  const isRepresentativeExpr = hasIsRepresentative ? "COALESCE(is_representative, 0)" : "0";
  const representativeTypeExpr = hasRepresentativeType
    ? "COALESCE(representative_type, 0)"
    : `CASE
         WHEN ${isRepresentativeExpr} = 2 THEN 2
         WHEN ${isRepresentativeExpr} = 1 THEN 1
         WHEN ${isUserAssignedExpr} = 1 THEN 2
         ELSE 0
       END`;

  console.log("🚀 开始修复 face_clusters 外键 -> media_face_embeddings ...");
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("BEGIN").run();

  try {
    db.prepare("DROP TABLE IF EXISTS face_clusters__fix_new").run();

    db.prepare(`
      CREATE TABLE face_clusters__fix_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        cluster_id INTEGER NOT NULL,
        face_embedding_id INTEGER NOT NULL,
        similarity_score REAL,
        representative_type INTEGER DEFAULT 0,
        name TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        is_user_assigned BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (face_embedding_id) REFERENCES media_face_embeddings(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, cluster_id, face_embedding_id)
      )
    `).run();

    db.prepare(`
      INSERT INTO face_clusters__fix_new (
        id,
        user_id,
        cluster_id,
        face_embedding_id,
        similarity_score,
        representative_type,
        name,
        created_at,
        updated_at,
        is_user_assigned
      )
      SELECT
        id,
        user_id,
        cluster_id,
        face_embedding_id,
        similarity_score,
        ${representativeTypeExpr} AS representative_type,
        name,
        created_at,
        updated_at,
        ${isUserAssignedExpr} AS is_user_assigned
      FROM face_clusters
    `).run();

    db.prepare("DROP TABLE face_clusters").run();
    db.prepare("ALTER TABLE face_clusters__fix_new RENAME TO face_clusters").run();

    db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_user_id ON face_clusters(user_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_id ON face_clusters(cluster_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_user ON face_clusters(cluster_id, user_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_embedding_cluster ON face_clusters(face_embedding_id, cluster_id)").run();
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_face_clusters_user_cluster_rep ON face_clusters(user_id, cluster_id, representative_type DESC, similarity_score DESC)",
    ).run();

    db.prepare("COMMIT").run();
  } catch (error) {
    db.prepare("ROLLBACK").run();
    throw error;
  } finally {
    db.prepare("PRAGMA foreign_keys = ON").run();
  }

  const fixedTarget = getFaceClustersFkTarget();
  if (fixedTarget !== "media_face_embeddings") {
    throw new Error(`修复后校验失败：face_clusters 仍引用 ${fixedTarget || "UNKNOWN"}`);
  }

  const fkIssues = db.prepare("PRAGMA foreign_key_check").all();
  if (fkIssues.length > 0) {
    console.warn("⚠️  foreign_key_check 发现潜在问题：", fkIssues);
  }

  console.log("✅ face_clusters 外键修复完成。");
}

if (require.main === module) {
  try {
    recreateFaceClustersWithMediaFk();
  } catch (error) {
    console.error("❌ 修复失败:", error.message);
    process.exit(1);
  }
}

module.exports = {
  recreateFaceClustersWithMediaFk,
};
