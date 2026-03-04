/*
 * 检查 audio 类型图片在数据库中的时间相关字段
 * 用于验证 audio 是否有 date_key, year_key, month_key, day_key, image_created_at 等时间记录
 *
 * @Usage: node scripts/tmp-scripts/check-audio-time-records.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function main() {
  const rows = db
    .prepare(
      `SELECT id, media_type, date_key, year_key, month_key, day_key, image_created_at
       FROM images
       WHERE media_type = 'audio' AND deleted_at IS NULL
       LIMIT 20`
    )
    .all();

  console.log("Audio records (time fields):");
  console.log(JSON.stringify(rows, null, 2));
  console.log(`\nTotal: ${rows.length} records`);
}

main();
