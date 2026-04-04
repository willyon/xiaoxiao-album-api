/*
 * @Description: 删除并重建 app_config（key_type / enabled / api_key / updated_at；id 自增）。会清空已存配置。
 *
 * @Usage（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/recreate-app-settings-table.js
 */

const path = require("path");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableAppConfig } = require(path.join(projectRoot, "src", "models", "initTableModel"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function main() {
  console.log("🔧 准备重建 app_config（及清理遗留 app_settings）…");

  if (tableExists("app_settings")) {
    console.log("🗑️  删除旧表 app_settings …");
    db.prepare("DROP TABLE IF EXISTS app_settings").run();
  }

  if (tableExists("app_config")) {
    console.log("🗑️  删除 app_config …");
    db.prepare("DROP TABLE IF EXISTS app_config").run();
  }

  createTableAppConfig();
  const ts = Date.now();
  db.prepare("INSERT INTO app_config (key_type, enabled, updated_at) VALUES ('cloud_model', 0, ?)").run(ts);
  db.prepare("INSERT INTO app_config (key_type, enabled, updated_at) VALUES ('amap', 0, ?)").run(ts);
  console.log("✅ app_config 已重建并初始化 key_type=cloud_model 与 amap。");
}

main();
