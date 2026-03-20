/*
 * @Description: 从 media 表删除 storage_type 列（存储方式仅由 .env 的 STORAGE_TYPE 决定；可重跑，列已不存在则跳过）
 * @Usage: node scripts/tmp-scripts/migrate-drop-media-storage-type.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function main() {
  const cols = db.prepare("PRAGMA table_info(media)").all();
  if (!cols.some((c) => c.name === "storage_type")) {
    console.log("media.storage_type 不存在，跳过");
    return;
  }
  db.prepare("ALTER TABLE media DROP COLUMN storage_type").run();
  console.log("已删除 media.storage_type");
}

main();
