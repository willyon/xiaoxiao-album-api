/*
 * 一次性迁移脚本：为搜索筛选（FilterSidebar）相关条件补充 / 调整索引。
 *
 * 包含以下操作：
 * 1. 为 media 表添加：
 *    - idx_media_user_analysis_status_primary ON media(user_id, analysis_status_primary)
 *    - idx_media_user_analysis_status_cloud   ON media(user_id, analysis_status_cloud)
 *    - idx_media_user_face_count              ON media(user_id, face_count)
 *    - idx_media_user_person_count            ON media(user_id, person_count)
 * 2. 为 media_search 表添加：
 *    - idx_media_search_user_ocr ON media_search(user_id, ocr_text)
 *
 * 所有 CREATE INDEX 均使用 IF NOT EXISTS，重复执行不会报错，设计为幂等。
 *
 * 用法（在项目根目录下）：
 *   cd xiaoxiao-project-service
 *   NODE_ENV=production node scripts/tmp-scripts/migrate-media-add-search-filter-indexes.js
 */

const { db } = require("../../src/services/database");

function migrate() {
  db.exec("BEGIN TRANSACTION");
  try {
    // media 表上的组合索引
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_media_user_analysis_status_primary ON media(user_id, analysis_status_primary);",
    ).run();
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_media_user_analysis_status_cloud ON media(user_id, analysis_status_cloud);",
    ).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_face_count ON media(user_id, face_count);").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_person_count ON media(user_id, person_count);").run();

    // media_search 上的 OCR 相关索引（有/无文字筛选）
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_user_ocr ON media_search(user_id, ocr_text);").run();

    db.exec("COMMIT");
    console.log("🎉 迁移完成：已为搜索筛选相关字段创建/补充索引。");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("❌ 迁移失败，已回滚。错误信息：", error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  migrate();
}

