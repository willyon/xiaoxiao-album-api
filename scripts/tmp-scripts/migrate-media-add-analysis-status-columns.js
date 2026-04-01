/*
 * 一次性迁移：为 media 表新增 analysis_status_primary / analysis_status_cloud 字段，
 * 并将旧 analysis_status 字段的状态迁移到 analysis_status_primary。
 *
 * 设计要点：
 * - 新增列均为 TEXT，默认值 'pending'，用于表示本地/云端智能分析阶段状态；
 * - 若存在旧列 analysis_status（running/failed/done），映射为：
 *   - running -> 'running'
 *   - failed  -> 'failed'
 *   - done    -> 'success'
 *   - 其它 / NULL -> 'pending'
 *
 * 使用方式（在 xiaoxiao-project-service 根目录执行）：
 *   node scripts/tmp-scripts/migrate-media-add-analysis-status-columns.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

// 将工作目录切换到项目根目录，复用现有 database 服务配置
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").get()) {
    console.log("media 表不存在，跳过");
    return;
  }

  const cols = columnNames("media");

  db.exec("BEGIN TRANSACTION");
  try {
    if (!cols.includes("analysis_status_primary")) {
      db.prepare("ALTER TABLE media ADD COLUMN analysis_status_primary TEXT DEFAULT 'pending'").run();
      console.log("✅ 已新增列 media.analysis_status_primary（默认值 'pending'）");
    } else {
      console.log("ℹ️ media.analysis_status_primary 已存在，跳过 ADD COLUMN");
    }

    if (!cols.includes("analysis_status_cloud")) {
      db.prepare("ALTER TABLE media ADD COLUMN analysis_status_cloud TEXT DEFAULT 'pending'").run();
      console.log("✅ 已新增列 media.analysis_status_cloud（默认值 'pending'）");
    } else {
      console.log("ℹ️ media.analysis_status_cloud 已存在，跳过 ADD COLUMN");
    }

    // 若存在旧列 analysis_status，则将其状态迁移到 analysis_status_primary
    if (cols.includes("analysis_status")) {
      db.prepare(
        `
        UPDATE media
        SET analysis_status_primary = CASE
          WHEN analysis_status = 'running' THEN 'running'
          WHEN analysis_status = 'failed'  THEN 'failed'
          WHEN analysis_status = 'done'    THEN 'success'
          ELSE COALESCE(analysis_status_primary, 'pending')
        END
      `,
      ).run();
      console.log("✅ 已根据旧列 analysis_status 初始化 analysis_status_primary");
    } else {
      console.log("ℹ️ 未检测到旧列 analysis_status，跳过状态迁移");
    }

    db.exec("COMMIT");
    console.log("🎉 迁移完成：analysis_status_primary / analysis_status_cloud 已就绪");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}

migrate();

