/**
 * 数据库重建脚本：删除所有业务表，并按 initTableModel 中的 createTable* 按外键依赖顺序重建。
 * 使用方式：node scripts/deployment/rebuild-database.js
 *
 * 覆盖表：users, media, media_analysis（文案/OCR 在 media.ai_*）,
 *        media_face_embeddings, media_embeddings, video_keyframes, video_transcripts,
 *        albums, album_media, face_clusters, face_cluster_representatives, face_cluster_meta,
 *        similar_groups, similar_group_members, media_search, media_search_fts, media_search_terms
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableUsers,
  createTableMedia,
  createTableMediaAnalysis,
  createTableMediaFaceEmbeddings,
  createTableMediaEmbeddings,
  createTableVideoKeyframes,
  createTableVideoTranscripts,
  createTableAlbumsMediaVersion,
  createTableAlbumMedia,
  createTableFaceClustersMediaVersion,
  createTableFaceClusterRepresentatives,
  createTableFaceClusterMeta,
  createTableSimilarGroupsMediaVersion,
  createTableSimilarGroupMembersMediaVersion,
  createTableMediaSearch,
  createTableMediaSearchFts,
  createTableMediaSearchTerms,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));

/** 按外键依赖顺序：先删被引用表，再删主表 */
const TABLES_TO_DROP = [
  "album_media",
  "albums",
  "video_transcripts",
  "video_keyframes",
  "media_search_fts",
  "media_fts",
  "media_search_terms",
  "media_search",
  "media_analysis",
  "similar_group_members",
  "similar_groups",
  "face_cluster_representatives",
  "face_cluster_meta",
  "face_clusters",
  "media_face_embeddings",
  "media_embeddings",
  "media",
  "users",
];

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

async function rebuildDatabase() {
  try {
    console.log("🚀 开始重建数据库...");
    console.log("⚠️  警告：此操作将删除所有现有业务表及数据！");

    const existing = TABLES_TO_DROP.filter((t) => tableExists(t));
    if (existing.length === 0) {
      console.log("ℹ️  未发现现有业务表，将直接创建新表...");
    } else {
      console.log("📊 发现现有表，准备删除并重建:", existing.join(", "));
    }

    db.prepare("BEGIN TRANSACTION").run();

    try {
      console.log("🗑️  删除现有表...");
      for (const name of TABLES_TO_DROP) {
        if (tableExists(name)) {
          db.prepare(`DROP TABLE IF EXISTS ${name}`).run();
          console.log("   ✅ 删除", name);
        }
      }

      console.log("📝 创建新表（与 initTableModel 一致）...");

      createTableUsers();
      createTableMedia();
      createTableMediaAnalysis();
      createTableMediaFaceEmbeddings();
      createTableMediaEmbeddings();
      createTableVideoKeyframes();
      createTableVideoTranscripts();
      createTableAlbumsMediaVersion();
      createTableAlbumMedia();
      createTableFaceClustersMediaVersion();
      createTableFaceClusterRepresentatives();
      createTableFaceClusterMeta();
      createTableSimilarGroupsMediaVersion();
      createTableSimilarGroupMembersMediaVersion();
      createTableMediaSearch();
      createTableMediaSearchFts();
      createTableMediaSearchTerms();

      db.prepare("COMMIT").run();

      console.log("🎉 数据库重建完成！");
      console.log(
        "📋 已创建表：users, media, media_analysis, media_face_embeddings, media_embeddings, video_keyframes, video_transcripts, albums, album_media, face_clusters, face_cluster_representatives, face_cluster_meta, similar_groups, similar_group_members, media_search, media_search_fts, media_search_terms",
      );
    } catch (err) {
      db.prepare("ROLLBACK").run();
      throw err;
    }
  } catch (error) {
    console.error("❌ 数据库重建失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  rebuildDatabase().then(() => process.exit(0));
}

module.exports = { rebuildDatabase };
