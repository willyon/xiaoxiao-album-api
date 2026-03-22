/**
 * 全量重建搜索文档：media_search、media_search_terms、media_search_fts。
 * 与 rebuild-media-search-indexes.js 相同逻辑；无参数即处理所有未删除的 media。
 * 在 OCR/文案等字段迁移或 bulk 更新后建议执行一次。
 *
 * @Usage: node scripts/tmp-scripts/rebuild-all-media-search-docs.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { rebuildMediaSearchIndexes } = require("./rebuild-media-search-indexes");

rebuildMediaSearchIndexes().catch((error) => {
  console.error("❌ 全量搜索文档重建失败:", error.message);
  process.exit(1);
});
