/*
 * @Description: 将 app_config 迁为含 key_type：cloud_model / amap，列 id(自增) / key_type / enabled / api_key / updated_at。
 * 兼容：宽列单行、旧版仅用 id=1/2 区分且无 key_type 的四列表。
 *
 * @Usage（在 xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/migrate-app-config-to-four-column-rows.js
 *
 * 可重复执行：已是新结构则只补齐缺失的 key_type 行。
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

function isLegacyWideConfig() {
  if (!tableExists("app_config")) return false;
  return columnNames("app_config").includes("cloud_model_enabled");
}

function hasKeyTypeColumn() {
  if (!tableExists("app_config")) return false;
  return columnNames("app_config").includes("key_type");
}

/** 旧四列：无 key_type、无宽列，靠固定 id 1/2 */
function isLegacyIdKeyedFourCol() {
  if (!tableExists("app_config")) return false;
  const cols = columnNames("app_config");
  return (
    cols.includes("enabled") &&
    cols.includes("api_key") &&
    !cols.includes("key_type") &&
    !cols.includes("cloud_model_enabled")
  );
}

function ensureKeyTypeRows(ts) {
  for (const kt of [KT_CLOUD, KT_AMAP]) {
    const row = db.prepare("SELECT 1 FROM app_config WHERE key_type = ?").get(kt);
    if (!row) {
      db.prepare("INSERT INTO app_config (key_type, enabled, updated_at) VALUES (?, 0, ?)").run(kt, ts);
      console.log(`✅ 已插入 app_config 默认行 key_type=${kt}`);
    }
  }
}

function migrateFromIdKeyedTable(ts) {
  const rows = db.prepare("SELECT * FROM app_config ORDER BY id").all();
  const byId = {};
  for (const r of rows) byId[r.id] = r;
  const cloud = byId[1] || { enabled: 0, api_key: null, updated_at: ts };
  const amap = byId[2] || { enabled: 0, api_key: null, updated_at: ts };
  const u1 = cloud.updated_at != null ? Number(cloud.updated_at) : ts;
  const u2 = amap.updated_at != null ? Number(amap.updated_at) : ts;

  db.prepare("DROP TABLE app_config").run();
  createTableAppConfig();
  db.prepare(
    "INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)",
  ).run(KT_CLOUD, cloud.enabled ? 1 : 0, cloud.api_key != null ? String(cloud.api_key).trim() || null : null, u1);
  db.prepare(
    "INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)",
  ).run(KT_AMAP, amap.enabled ? 1 : 0, amap.api_key != null ? String(amap.api_key).trim() || null : null, u2);
  console.log("✅ 已从旧版（固定 id=1/2）迁移为 key_type（cloud_model / amap）。");
}

function main() {
  const ts = Date.now();

  if (!tableExists("app_config")) {
    createTableAppConfig();
    ensureKeyTypeRows(ts);
    console.log("✅ 已创建 app_config（含 key_type）并初始化两行。");
    return;
  }

  if (isLegacyWideConfig()) {
    const row = db.prepare("SELECT * FROM app_config WHERE id = 1").get();
    const cloudEn = row.cloud_model_enabled ? 1 : 0;
    const amapEn = row.amap_reverse_geocode_enabled ? 1 : 0;
    const bailian = row.aliyun_bailian_api_key != null ? String(row.aliyun_bailian_api_key).trim() || null : null;
    const amapKey = row.amap_api_key != null ? String(row.amap_api_key).trim() || null : null;
    const u = row.updated_at != null ? Number(row.updated_at) : ts;

    db.prepare("DROP TABLE app_config").run();
    createTableAppConfig();
    db.prepare(
      "INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)",
    ).run(KT_CLOUD, cloudEn, bailian, u);
    db.prepare(
      "INSERT INTO app_config (key_type, enabled, api_key, updated_at) VALUES (?, ?, ?, ?)",
    ).run(KT_AMAP, amapEn, amapKey, u);
    console.log("✅ 已从旧版宽列 app_config 迁移为 key_type 两行。");
    return;
  }

  if (isLegacyIdKeyedFourCol()) {
    migrateFromIdKeyedTable(ts);
    return;
  }

  if (hasKeyTypeColumn()) {
    ensureKeyTypeRows(ts);
    console.log("ℹ️  app_config 已是 key_type 结构，已补齐缺失行。");
    return;
  }

  console.warn("⚠️  app_config 结构未识别，请手动检查 PRAGMA table_info(app_config)。");
}

main();
