/*
 * @Description: app_config 增加 user_id，并迁移为按 (user_id, key_type) 唯一。
 *
 * @Usage（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-app-config-add-user-id.js
 *
 * 迁移规则：
 * - 历史数据统一写入 user_id = 1
 * - 重建表结构，确保 user_id NOT NULL + FOREIGN KEY + UNIQUE(user_id, key_type)
 */

const path = require("path");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config({ path: path.join(projectRoot, ".env") });

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function main() {
  if (!tableExists("app_config")) {
    throw new Error("app_config 不存在，无法迁移。");
  }

  const ts = Date.now();
  const cols = columnNames("app_config");

  db.prepare("BEGIN TRANSACTION").run();
  try {
    if (!cols.includes("user_id")) {
      db.prepare("ALTER TABLE app_config ADD COLUMN user_id INTEGER").run();
    }

    db.prepare("UPDATE app_config SET user_id = 1 WHERE user_id IS NULL").run();

    db.prepare(`
      CREATE TABLE app_config_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        api_key TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, key_type)
      )
    `).run();

    db.prepare(`
      INSERT INTO app_config_new (id, user_id, key_type, enabled, api_key, updated_at)
      SELECT
        id,
        COALESCE(user_id, 1),
        key_type,
        COALESCE(enabled, 0),
        api_key,
        COALESCE(updated_at, ?)
      FROM app_config
    `).run(ts);

    db.prepare("DROP TABLE app_config").run();
    db.prepare("ALTER TABLE app_config_new RENAME TO app_config").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_app_config_user_id ON app_config(user_id)").run();

    db.prepare("COMMIT").run();
    console.log("✅ app_config 已迁移：新增 user_id，历史数据已写入 user_id=1。");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    throw error;
  }
}

main();
