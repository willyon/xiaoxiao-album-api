/*
 * 一次性迁移脚本：
 * - 删除 video_transcripts 表
 * - 从 media_search 表中删除 transcript_text 列
 * - 重建 media_search_fts 虚拟表（去掉 transcript_text 列）
 *
 * 说明：
 * - 当前系统已通过抽帧 + 云模型理解支持视频内容搜索，暂不需要语音转写维度。
 * - transcript_text 在搜索流程中也不再使用，可以一并移除以简化 schema。
 *
 * 使用方式（在 xiaoxiao-project-service 根目录）：
 *   NODE_ENV=production node scripts/tmp-scripts/migrate-drop-video-transcripts-and-transcript-text.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  db.exec("BEGIN TRANSACTION");
  try {
    // 1）删除 video_transcripts 表（如存在）
    if (tableExists("video_transcripts")) {
      console.log("🔧 检测到表 video_transcripts，准备删除该表…");
      db.prepare("DROP TABLE IF EXISTS video_transcripts;").run();
      console.log("✅ 已删除表 video_transcripts。");
    } else {
      console.log("ℹ️ 表 video_transcripts 不存在，跳过删除。");
    }

    // 2）从 media_search 中删除 transcript_text 列（如存在）
    if (tableExists("media_search") && columnNames("media_search").includes("transcript_text")) {
      console.log("🔧 检测到 media_search.transcript_text 列，准备重建表以删除该列…");

      // 重建 media_search：不含 transcript_text 列
      db.prepare(
        `
        CREATE TABLE media_search_new (
          media_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          description_text TEXT,
          keywords_text TEXT,
          subject_tags_text TEXT,
          action_tags_text TEXT,
          scene_tags_text TEXT,
          ocr_text TEXT,
          caption_search_terms TEXT,
          updated_at INTEGER,
          FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
        );
      `,
      ).run();

      db.prepare(
        `
        INSERT INTO media_search_new (
          media_id, user_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
          ocr_text, caption_search_terms, updated_at
        )
        SELECT
          media_id, user_id, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text,
          ocr_text, caption_search_terms, updated_at
        FROM media_search;
      `,
      ).run();

      db.prepare("DROP TABLE media_search;").run();
      db.prepare("ALTER TABLE media_search_new RENAME TO media_search;").run();

      db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_user_id ON media_search(user_id);").run();

      console.log("✅ 已重建 media_search 表（不含 transcript_text 列）。");
    } else {
      console.log("ℹ️ media_search.transcript_text 列不存在或表缺失，跳过列删除。");
    }

    // 3）重建 media_search_fts（去掉 transcript_text 列）
    console.log("🔧 重建 media_search_fts 虚拟表（移除 transcript_text 列）…");
    db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
    db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
    db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();
    db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
    db.prepare(
      `
      CREATE VIRTUAL TABLE media_search_fts USING fts5(
        description_text,
        keywords_text,
        subject_tags_text,
        action_tags_text,
        scene_tags_text,
        caption_search_terms
      );
    `,
    ).run();
    console.log("✅ 已重建 media_search_fts。");

    db.exec("COMMIT");
    console.log("🎉 迁移完成：video_transcripts 表及 transcript_text 相关字段/FTS 已移除。");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚。错误信息：", error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  migrate();
}

