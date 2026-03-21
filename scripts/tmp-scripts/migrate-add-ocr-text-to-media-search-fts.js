/*
 * @Description: 为 media_search_fts 增加 ocr_text 列（与图片理解同表、OCR 检索走列级 MATCH），并重建 FTS。
 * @Usage: node scripts/tmp-scripts/migrate-add-ocr-text-to-media-search-fts.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaSearchFts } = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { clearSearchRankCache } = require(path.join(projectRoot, "src", "utils", "searchRankCacheStore"));

function migrate() {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_search'").get()) {
    console.error("❌ 未找到 media_search 表");
    process.exit(1);
  }

  console.log("📝 重建 media_search_fts（加入 ocr_text 列）与触发器…");
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();
  db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
  createTableMediaSearchFts();
  console.log("   ✅ 已创建 media_search_fts（含 ocr_text）");

  console.log("📝 FTS rebuild（从 media_search 回填）…");
  db.prepare("INSERT INTO media_search_fts(media_search_fts) VALUES('rebuild')").run();
  console.log("   ✅ rebuild 完成");

  clearSearchRankCache();
  console.log("   ✅ 已清空搜索排序缓存");
}

migrate();
