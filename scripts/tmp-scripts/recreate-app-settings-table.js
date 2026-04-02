/**
 * 临时脚本：重新创建 app_settings 表
 *
 * 使用方式（在 xiaoxiao-project-service 目录下）：
 *   node scripts/tmp-scripts/recreate-app-settings-table.js
 *
 * 行为：
 * - 若存在 app_settings 表，先 DROP 再重建
 * - 重建逻辑复用 initTableModel.createTableAppSettings，保证结构与主代码一致
 */

const path = require("path");

// 切到 project root，保持与其他脚本一致
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableAppSettings } = require(path.join(projectRoot, "src", "models", "initTableModel"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function recreateAppSettings() {
  try {
    console.log("🔧 准备重新创建 app_settings 表...");

    if (tableExists("app_settings")) {
      console.log("🗑️  检测到已有 app_settings 表，先执行 DROP TABLE...");
      db.prepare("DROP TABLE IF EXISTS app_settings").run();
    } else {
      console.log("ℹ️  当前数据库中不存在 app_settings 表，将直接创建。");
    }

    console.log("📝 调用 initTableModel.createTableAppSettings 重新建表...");
    createTableAppSettings();

    console.log("✅ app_settings 表已重新创建完成。");
  } catch (err) {
    console.error("❌ 重新创建 app_settings 表失败：", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  recreateAppSettings();
}

module.exports = { recreateAppSettings };

