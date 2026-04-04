/*
 * @Description: 将旧版 app_settings（key-value 多行）迁移为 app_config（key_type + enabled + api_key），并删除 app_settings。
 *
 * @Usage（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-app-settings-to-app-config-singleton.js
 *
 * 可重复执行：若已无 app_settings，则仅补齐 app_config 缺失的 key_type 行。
 * 若当前已是「宽列」旧 app_config，请先运行 migrate-app-config-to-four-column-rows.js。
 */

const path = require("path");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config({ path: path.join(projectRoot, ".env") });

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableAppConfig } = require(path.join(projectRoot, "src", "models", "initTableModel"));

const KT_CLOUD = "cloud_model";
const KT_AMAP = "amap";

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function isWideLegacyAppConfig() {
  if (!tableExists("app_config")) return false;
  return columnNames("app_config").includes("cloud_model_enabled");
}

function parseLegacyBool(v) {
  if (v == null) return 0;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on" ? 1 : 0;
}

function ensureDefaultRows(ts) {
  for (const kt of [KT_CLOUD, KT_AMAP]) {
    if (!db.prepare("SELECT 1 FROM app_config WHERE key_type = ?").get(kt)) {
      db.prepare("INSERT INTO app_config (key_type, enabled, updated_at) VALUES (?, 0, ?)").run(kt, ts);
      console.log(`✅ 已插入 app_config 默认行 key_type=${kt}`);
    }
  }
}

function main() {
  const hasLegacy = tableExists("app_settings");

  if (hasLegacy && isWideLegacyAppConfig()) {
    console.error(
      "检测到宽列旧版 app_config，请先运行：node scripts/tmp-scripts/migrate-app-config-to-four-column-rows.js",
    );
    process.exit(1);
  }

  createTableAppConfig();

  if (!tableExists("app_config")) {
    console.error("创建 app_config 失败");
    process.exit(1);
  }

  const now = Date.now();

  if (!hasLegacy) {
    ensureDefaultRows(now);
    console.log("ℹ️  已无 app_settings，app_config 默认行已就绪。");
    return;
  }

  const appRows = db.prepare("SELECT key, value FROM app_settings").all();
  const map = {};
  for (const r of appRows) {
    if (r.key) map[r.key] = r.value;
  }

  const cloudEn = parseLegacyBool(map.cloud_model_enabled);
  const amapEn = parseLegacyBool(map.amap_reverse_geocode_enabled);
  const bailian = map.aliyun_bailian_api_key != null ? String(map.aliyun_bailian_api_key).trim() || null : null;
  const amapKey = map.amap_api_key != null ? String(map.amap_api_key).trim() || null : null;

  if (tableExists("app_config")) {
    db.prepare("DROP TABLE app_config").run();
  }
  createTableAppConfig();

  db.prepare("INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)").run(
    KT_CLOUD,
    cloudEn,
    bailian,
    now,
  );
  db.prepare("INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)").run(
    KT_AMAP,
    amapEn,
    amapKey,
    now,
  );

  db.prepare("DROP TABLE app_settings").run();
  console.log("✅ 已从 app_settings 写入 app_config（key_type=cloud_model / amap），并删除 app_settings");
}

main();
