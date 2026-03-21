/*
 * @deprecated 历史迁移脚本（曾为 media_search 补 ocr_search_terms 并重建 FTS）。
 * 当前 schema 以 initTableModel 为准；开发阶段请删库或全量重建，勿依赖本脚本。
 *
 * 推荐：
 *   node scripts/deployment/rebuild-database.js
 *   node scripts/tmp-scripts/rebuild-media-search-indexes.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

console.log("ℹ️  migrate-add-ocr-search-terms-column.js 已废弃。");
console.log("   请使用 scripts/deployment/rebuild-database.js，或删除 database.db 后重启；");
console.log("   再运行 scripts/tmp-scripts/rebuild-media-search-indexes.js 填充搜索索引。");
process.exit(0);
