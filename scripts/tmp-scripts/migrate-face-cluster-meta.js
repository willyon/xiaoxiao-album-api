/*
 * 一次性迁移：创建 face_cluster_meta 表（用于「最近使用人物」排序）
 * 新库由 initTableModel.createTableFaceClusterMeta 直接创建，无需运行本脚本。
 *
 * @Usage: node scripts/tmp-scripts/migrate-face-cluster-meta.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { createTableFaceClusterMeta } = require(path.join(projectRoot, "src", "models", "initTableModel"));

createTableFaceClusterMeta();
console.log("✅ 迁移完成：face_cluster_meta 表已创建（若已存在则跳过）");
