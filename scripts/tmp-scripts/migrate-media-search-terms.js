/*
 * @Description: 重建 media_search_terms（不含 OCR 字段），并重建 media_search_fts（已移除 ocr_text 列）。
 * OCR 文本仍保存在 media_search.ocr_text，仅不再进入 FTS；OCR 检索走 LIKE。
 * @Usage: node scripts/tmp-scripts/migrate-media-search-terms.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableMediaSearchTerms,
  createTableMediaSearchFts,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { buildMediaSearchTermRows } = require(path.join(projectRoot, "src", "utils", "searchTermUtils"));
const { clearSearchRankCache } = require(path.join(projectRoot, "src", "utils", "searchRankCacheStore"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function rebuildMediaSearchFtsWithoutOcrColumn() {
  console.log("📝 重建 media_search_fts（FTS 列已不含 ocr_text）…");
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();
  db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
  createTableMediaSearchFts();
  console.log("   ✅ 已创建 media_search_fts 与触发器");

  console.log("📝 FTS rebuild（从 media_search 回填）…");
  db.prepare("INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild')").run();
  console.log("   ✅ rebuild 完成");
}

function rebuildMediaSearchTerms() {
  if (!tableExists("media_search")) {
    throw new Error("未找到 media_search 表，无法重建 media_search_terms");
  }

  createTableMediaSearchTerms();
  db.prepare("DELETE FROM media_search_terms").run();

  const rows = db.prepare(`
    SELECT media_id, user_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, transcript_text, updated_at
    FROM media_search
  `).all();

  const insertStmt = db.prepare(`
    INSERT INTO media_search_terms (
      media_id, user_id, field_type, term, term_len, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const row of rows) {
    const termRows = buildMediaSearchTermRows({
      mediaId: row.media_id,
      userId: row.user_id,
      fields: {
        description: row.description_text,
        keywords: row.keywords_text,
        subject_tags: row.subject_tags_text,
        action_tags: row.action_tags_text,
        scene_tags: row.scene_tags_text,
        transcript: row.transcript_text,
      },
      updatedAt: row.updated_at || Date.now(),
    });

    for (const termRow of termRows) {
      insertStmt.run(
        termRow.mediaId,
        termRow.userId,
        termRow.fieldType,
        termRow.term,
        termRow.termLen,
        termRow.updatedAt,
      );
      inserted += 1;
    }
  }

  return { mediaCount: rows.length, inserted };
}

function main() {
  console.log("🚀 开始重建 media_search_terms 与 media_search_fts…");
  db.prepare("BEGIN").run();
  try {
    const result = rebuildMediaSearchTerms();
    console.log(`✅ media_search_terms：处理 ${result.mediaCount} 条 media_search，写入 ${result.inserted} 条 term 索引`);

    rebuildMediaSearchFtsWithoutOcrColumn();

    clearSearchRankCache();

    db.prepare("COMMIT").run();
    console.log("🎉 全部完成");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 重建失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  rebuildMediaSearchTerms,
  rebuildMediaSearchFtsWithoutOcrColumn,
};
