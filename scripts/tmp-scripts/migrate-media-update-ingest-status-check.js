/*
 * 已合并至 migrate-media-ingest-status-unify-enums.js（列名 meta_pipeline_status + 枚举统一）。
 * 请执行：
 *   node scripts/tmp-scripts/migrate-media-ingest-status-unify-enums.js
 * 若仅需重命名列（枚举已是新四态）：
 *   node scripts/tmp-scripts/migrate-media-rename-ingest-status-to-meta-pipeline.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require(path.join(scriptDir, "migrate-media-ingest-status-unify-enums.js"));
