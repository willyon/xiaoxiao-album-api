/*
 * @Description: 保留现有数据的搜索 schema 迁移脚本
 * 为 media_captions / media_search 补充主体、动作、场景字段，
 * 重建 media_fts，并重新物化 media_search / media_search_terms。
 *
 * @Usage: node scripts/tmp-scripts/migrate-scene-search-schema.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableMediaCaptions,
  createTableMediaSearch,
  createTableMediaFts,
  createTableMediaSearchTerms,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { rebuildMediaSearchDoc } = require(path.join(projectRoot, "src", "models", "mediaModel"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function getColumnNames(tableName) {
  if (!tableExists(tableName)) {
    return [];
  }
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
  const columns = new Set(getColumnNames(tableName));
  if (columns.has(columnName)) {
    console.log(`ℹ️ ${tableName}.${columnName} 已存在，跳过`);
    return false;
  }
  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  console.log(`✅ 已添加列 ${tableName}.${columnName}`);
  return true;
}

function ensureBaseTables() {
  createTableMediaCaptions();
  createTableMediaSearch();
  createTableMediaSearchTerms();
}

function migrateSchemaColumns() {
  if (!tableExists("media_captions")) {
    throw new Error("未找到 media_captions 表");
  }
  if (!tableExists("media_search")) {
    throw new Error("未找到 media_search 表");
  }

  let changedColumns = 0;

  changedColumns += Number(addColumnIfMissing("media_captions", "subject_tags_json", "TEXT"));
  changedColumns += Number(addColumnIfMissing("media_captions", "action_tags_json", "TEXT"));
  changedColumns += Number(addColumnIfMissing("media_captions", "scene_tags_json", "TEXT"));

  changedColumns += Number(addColumnIfMissing("media_search", "subject_tags_text", "TEXT"));
  changedColumns += Number(addColumnIfMissing("media_search", "action_tags_text", "TEXT"));
  changedColumns += Number(addColumnIfMissing("media_search", "scene_tags_text", "TEXT"));

  return changedColumns;
}

function recreateMediaFts() {
  db.prepare("DROP TABLE IF EXISTS media_fts").run();
  console.log("✅ 已删除旧 media_fts");
  createTableMediaFts();
  console.log("✅ 已按新结构创建 media_fts");
}

function listMediaIds() {
  return db.prepare(`
    SELECT id
    FROM media
    WHERE deleted_at IS NULL
    ORDER BY id ASC
  `).pluck().all();
}

function rebuildSearchArtifacts() {
  const mediaIds = listMediaIds();
  console.log(`📦 待重建媒体数: ${mediaIds.length}`);

  let rebuiltCount = 0;
  let totalTermRows = 0;

  for (const mediaId of mediaIds) {
    const result = rebuildMediaSearchDoc(mediaId, { rebuildFts: false });
    rebuiltCount += result.affectedRows > 0 ? 1 : 0;
    totalTermRows += result.termRows || 0;
  }

  db.prepare("INSERT INTO media_fts(media_fts) VALUES('rebuild')").run();

  return {
    mediaCount: mediaIds.length,
    rebuiltCount,
    totalTermRows,
  };
}

function main() {
  console.log("🚀 开始迁移主体/动作/场景搜索 schema...");

  ensureBaseTables();

  db.prepare("BEGIN").run();
  try {
    const changedColumns = migrateSchemaColumns();
    recreateMediaFts();
    const rebuildResult = rebuildSearchArtifacts();
    db.prepare("COMMIT").run();

    console.log("🎉 迁移完成");
    console.log(`   - 新增列数: ${changedColumns}`);
    console.log(`   - 处理媒体数: ${rebuildResult.mediaCount}`);
    console.log(`   - 重建文档数: ${rebuildResult.rebuiltCount}`);
    console.log(`   - term 行数: ${rebuildResult.totalTermRows}`);
  } catch (error) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 迁移失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  migrateSchemaColumns,
  recreateMediaFts,
  rebuildSearchArtifacts,
};
