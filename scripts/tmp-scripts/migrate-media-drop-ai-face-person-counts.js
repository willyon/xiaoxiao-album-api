/*
 * 一次性迁移：合并 ai_face_count / ai_person_count 到 face_count / person_count 后删除两列。
 * 1. WHERE ai_face_count IS NOT NULL：face_count = ai_face_count（云侧覆盖）
 * 2. WHERE ai_person_count IS NOT NULL：person_count = ai_person_count
 * 3. ALTER TABLE DROP COLUMN（需 SQLite 3.35+）
 *
 * 新库请使用 initTableModel.createTableMedia（已无 ai_* 列），无需运行本脚本。
 * 可重跑：列已不存在则跳过。
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-media-drop-ai-face-person-counts.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

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
  const hasAiFace = cols.includes("ai_face_count");
  const hasAiPerson = cols.includes("ai_person_count");

  if (!hasAiFace && !hasAiPerson) {
    console.log("media 已无 ai_face_count / ai_person_count，跳过");
    return;
  }

  const tx = db.transaction(() => {
    if (hasAiFace) {
      const r = db.prepare("UPDATE media SET face_count = ai_face_count WHERE ai_face_count IS NOT NULL").run();
      console.log(`✅ 已用 ai_face_count 覆盖 face_count，影响行数: ${r.changes}`);
    }
    if (hasAiPerson) {
      const r = db.prepare("UPDATE media SET person_count = ai_person_count WHERE ai_person_count IS NOT NULL").run();
      console.log(`✅ 已用 ai_person_count 覆盖 person_count，影响行数: ${r.changes}`);
    }
    if (hasAiFace) {
      db.prepare("ALTER TABLE media DROP COLUMN ai_face_count").run();
      console.log("✅ 已删除列 ai_face_count");
    }
    if (hasAiPerson) {
      db.prepare("ALTER TABLE media DROP COLUMN ai_person_count").run();
      console.log("✅ 已删除列 ai_person_count");
    }
  });

  try {
    tx();
  } catch (e) {
    console.error("迁移失败（若 SQLite 版本 < 3.35 不支持 DROP COLUMN，请升级或手动重建 media 表）:", e.message);
    process.exitCode = 1;
    return;
  }

  console.log("迁移结束");
}

migrate();
