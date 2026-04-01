/*
 * 一次性迁移脚本：删除 video_keyframes 表。
 *
 * 背景：
 * - 早期为视频抽帧预留了 video_keyframes 表，但当前业务并未真正使用该表。
 * - 为简化 schema 与维护成本，这里提供一个安全的删表脚本。
 *
 * 行为：
 * - 若 video_keyframes 表不存在，则直接打印提示并退出。
 * - 若存在，则执行 DROP TABLE video_keyframes。
 *
 * 使用方式（在 xiaoxiao-project-service 根目录）：
 *   NODE_ENV=production node scripts/tmp-scripts/migrate-drop-video-keyframes-table.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function migrate() {
  if (!tableExists("video_keyframes")) {
    console.log("ℹ️ 表 video_keyframes 不存在，无需删除。");
    return;
  }

  console.log("🔧 检测到表 video_keyframes，准备删除该表…");
  db.exec("BEGIN TRANSACTION");
  try {
    db.prepare("DROP TABLE IF EXISTS video_keyframes;").run();
    db.exec("COMMIT");
    console.log("🎉 已删除表 video_keyframes。");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 删除表 video_keyframes 失败，已回滚。错误信息：", error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  migrate();
}

