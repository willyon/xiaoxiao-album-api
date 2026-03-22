/*
 * 一次性数据迁移：将 media.ai_visible_text 的内容写入 media.ai_ocr（在 migrate-media-drop-ai-visible-text.js 之前执行）
 *
 * 模式（环境变量 COPY_VISIBLE_TO_OCR_MODE，默认 fill_empty）：
 * - fill_empty：仅当 ai_ocr 为空（NULL 或仅空白）时，用 ai_visible_text 非空内容填充
 * - overwrite：凡 ai_visible_text 非空，则将该行 ai_ocr 设为 ai_visible_text（会覆盖已有 ai_ocr）
 *
 * @Usage:
 *   node scripts/tmp-scripts/migrate-media-copy-ai-visible-text-to-ai-ocr.js
 *   COPY_VISIBLE_TO_OCR_MODE=overwrite node scripts/tmp-scripts/migrate-media-copy-ai-visible-text-to-ai-ocr.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));

function migrate() {
  const info = db.prepare("PRAGMA table_info(media)").all();
  const names = new Set(info.map((c) => c.name));
  if (!names.has("ai_visible_text") || !names.has("ai_ocr")) {
    console.error("media 表缺少 ai_visible_text 或 ai_ocr 列，已中止");
    process.exit(1);
  }

  const mode = (process.env.COPY_VISIBLE_TO_OCR_MODE || "fill_empty").trim().toLowerCase();

  let sql;
  if (mode === "overwrite") {
    sql = `
      UPDATE media
      SET ai_ocr = ai_visible_text
      WHERE ai_visible_text IS NOT NULL
        AND TRIM(ai_visible_text) != ''
    `;
  } else if (mode === "fill_empty") {
    sql = `
      UPDATE media
      SET ai_ocr = ai_visible_text
      WHERE (ai_ocr IS NULL OR TRIM(ai_ocr) = '')
        AND ai_visible_text IS NOT NULL
        AND TRIM(ai_visible_text) != ''
    `;
  } else {
    console.error(`无效的 COPY_VISIBLE_TO_OCR_MODE=${mode}，请使用 fill_empty 或 overwrite`);
    process.exit(1);
  }

  const result = db.prepare(sql).run();
  console.log(`✅ 模式=${mode}，已更新 ${result.changes} 行`);
}

migrate();
