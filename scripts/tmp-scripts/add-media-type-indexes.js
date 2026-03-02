/*
 * 一次性迁移：为 images 表添加 media_type 相关索引
 * 新库由 initTableModel.createTableImages 直接包含这些索引，无需运行本脚本。
 *
 * @Usage: node scripts/tmp-scripts/add-media-type-indexes.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const indexes = db.prepare("PRAGMA index_list(images)").all();
  const indexNames = indexes.map((i) => i.name);

  if (indexNames.includes("idx_images_media_type")) {
    console.log("idx_images_media_type 已存在，跳过");
  } else {
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_images_media_type ON images(media_type)",
    ).run();
    console.log("✅ 已创建 idx_images_media_type");
  }

  if (indexNames.includes("idx_images_user_media_creation")) {
    console.log("idx_images_user_media_creation 已存在，跳过");
  } else {
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_images_user_media_creation ON images(user_id, media_type, image_created_at DESC)",
    ).run();
    console.log("✅ 已创建 idx_images_user_media_creation");
  }

  console.log("✅ media_type 索引迁移完成");
}

migrate();
