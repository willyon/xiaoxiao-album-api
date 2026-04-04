/*
 * 已合并至 migrate-media-ingest-status-unify-enums.js（见该文件说明）。
 *   node scripts/tmp-scripts/migrate-media-ingest-status-unify-enums.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require(path.join(scriptDir, "migrate-media-ingest-status-unify-enums.js"));
