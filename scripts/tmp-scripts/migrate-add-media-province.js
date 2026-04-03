/*
 * @Description: 为 media 表增加 province（省份）列，用于存放逆地理编码得到的省级名称。
 * 新库由 initTableModel.createTableMedia 已含该列；已有库需执行本脚本 ALTER。
 *
 * @Usage（在项目根 xiaoxiao-project-service）:
 *   node scripts/tmp-scripts/migrate-add-media-province.js
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

function getColumnNames(tableName) {
  if (!tableExists(tableName)) return [];
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function main() {
  if (!tableExists("media")) {
    console.error("未找到 media 表");
    process.exit(1);
  }
  const cols = new Set(getColumnNames("media"));
  if (cols.has("province")) {
    console.log("ℹ️ media.province 已存在，跳过");
    return;
  }
  db.prepare("ALTER TABLE media ADD COLUMN province TEXT").run();
  console.log("✅ 已添加列 media.province TEXT");
}

main();
