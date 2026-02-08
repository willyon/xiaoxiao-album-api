/*
 * 一次性迁移：创建 face_cluster_representatives 表（若不存在）
 * 新库由 rebuild-database.js / initTableModel 直接创建，无需运行本脚本。
 * 已有库请执行一次以支持「代表向量」与增量分配。
 *
 * @Usage: node scripts/tmp-scripts/migrate-face-cluster-representatives.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { createTableFaceClusterRepresentatives } = require(path.join(
  projectRoot,
  "src",
  "models",
  "initTableModel"
));

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function migrate() {
  if (tableExists("face_cluster_representatives")) {
    console.log("face_cluster_representatives 表已存在，跳过迁移");
    return;
  }
  createTableFaceClusterRepresentatives();
  console.log("✅ 迁移完成：已创建 face_cluster_representatives 表");
}

migrate();
