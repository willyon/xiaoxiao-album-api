/*
 * 迁移：从 similar_groups 表移除 total_size_bytes 列。
 *
 * 背景：
 * - 代码中已不再使用 similar_groups.total_size_bytes（仅历史上用于显示节省空间）；
 * - 新建库的表结构（initTableModel.createTableSimilarGroupsMediaVersion）也已经移除该列；
 * - 本脚本按 SQLite 推荐方式：建新表 → 迁移数据 → 删旧表 → 重命名。
 *
 * ⚠️ 注意：
 * - 请先备份数据库文件，再执行本脚本；
 * - 在 xiaoxiao-project-service 根目录执行：
 *     node scripts/tmp-scripts/migrate-similar-groups-remove-total-size-bytes.js
 * - 可安全重复执行：如果列已不存在，则直接跳过。
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

function getTableInfo(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function migrate() {
  if (!tableExists("similar_groups")) {
    console.log("similar_groups 表不存在，跳过迁移");
    return;
  }

  const info = getTableInfo("similar_groups");
  const hasTotalSizeBytes = info.some((col) => col.name === "total_size_bytes");
  if (!hasTotalSizeBytes) {
    console.log("similar_groups.total_size_bytes 已不存在，跳过迁移");
    return;
  }

  console.log("开始迁移：从 similar_groups 表移除 total_size_bytes 列...");

  db.exec("BEGIN TRANSACTION");
  try {
    // 1. 创建不含 total_size_bytes 的新表 similar_groups_new
    db.prepare(`
      CREATE TABLE similar_groups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        group_type TEXT NOT NULL,
        primary_media_id INTEGER,
        member_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (primary_media_id) REFERENCES media(id) ON DELETE SET NULL
      );
    `).run();

    // 2. 拷贝旧数据（排除 total_size_bytes）
    db.prepare(`
      INSERT INTO similar_groups_new (
        id,
        user_id,
        group_type,
        primary_media_id,
        member_count,
        created_at,
        updated_at
      )
      SELECT
        id,
        user_id,
        group_type,
        primary_media_id,
        member_count,
        created_at,
        updated_at
      FROM similar_groups;
    `).run();

    // 3. 替换旧表
    db.prepare("DROP TABLE similar_groups").run();
    db.prepare("ALTER TABLE similar_groups_new RENAME TO similar_groups").run();

    // 4. 重新创建索引（与 initTableModel.createTableSimilarGroupsMediaVersion 保持一致）
    db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_groups_user_type ON similar_groups(user_id, group_type);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_groups_user_updated ON similar_groups(user_id, updated_at DESC);").run();

    db.exec("COMMIT");
    console.log("✅ 迁移完成：similar_groups 表已移除 total_size_bytes 列");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚事务：", error);
    throw error;
  }
}

migrate();

