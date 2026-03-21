/**
 * 将旧表 media_text_blocks（多行/图）迁移为 media_ocr（每图一行），并删除旧表。
 * 已有 media_ocr 且 media_text_blocks 不存在时可直接退出。
 * 若 media_ocr 仍为旧列名（ocr_text / blocks_json），请先运行 migrate-media-ocr-columns.js。
 *
 * 使用：node scripts/tmp-scripts/migrate-media-text-blocks-to-media-ocr.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { createTableMediaOcr } = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { upgradeMediaOcrTableIfNeeded } = require(path.join(scriptDir, "migrate-media-ocr-columns"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function migrate() {
  createTableMediaOcr();
  upgradeMediaOcrTableIfNeeded();

  if (!tableExists("media_text_blocks")) {
    console.log("ℹ️  未找到 media_text_blocks，跳过迁移（可能已是 media_ocr）。");
    return;
  }

  const count = db.prepare("SELECT COUNT(*) AS n FROM media_text_blocks").get().n;
  if (count === 0) {
    console.log("🗑️  media_text_blocks 为空，直接 DROP…");
    db.prepare("DROP TABLE IF EXISTS media_text_blocks").run();
    console.log("✅ 完成。");
    return;
  }

  const mediaIds = db
    .prepare(
      `SELECT DISTINCT media_id FROM media_text_blocks
       WHERE source_type IS NULL OR source_type = 'ocr'
       ORDER BY media_id`,
    )
    .all();
  const selectRows = db.prepare(
    `SELECT text, bbox, confidence, analysis_version, created_at
     FROM media_text_blocks WHERE media_id = ? AND (source_type IS NULL OR source_type = 'ocr')
     ORDER BY rowid`,
  );

  const insert = db.prepare(`
    INSERT OR REPLACE INTO media_ocr (media_id, ocr, analysis_version, created_at)
    VALUES (?, ?, ?, ?)
  `);

  db.prepare("BEGIN").run();
  try {
    for (const { media_id: mediaId } of mediaIds) {
      const rows = selectRows.all(mediaId);
      const ocrText = rows
        .map((r) => (r.text != null && String(r.text).trim() ? String(r.text).trim() : ""))
        .filter(Boolean)
        .join(" ");
      const version = rows[rows.length - 1]?.analysis_version || null;
      const createdAt = rows[rows.length - 1]?.created_at || Date.now();
      insert.run(mediaId, ocrText || null, version, createdAt);
    }
    db.prepare("DROP TABLE media_text_blocks").run();
    db.prepare("COMMIT").run();
    console.log(`✅ 已迁移 ${mediaIds.length} 个 media_id 的 OCR 到 media_ocr，并删除 media_text_blocks。`);
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

migrate();
