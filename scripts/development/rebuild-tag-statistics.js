/*
 * @Author: assistant
 * @Description: 基于现有数据全量重建 tag_statistics 表
 * @Usage: node scripts/development/rebuild-tag-statistics.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { mapObjectLabel } = require(path.join(projectRoot, "src", "constants", "objectTaxonomy"));
const { mapSceneLabel } = require(path.join(projectRoot, "src", "constants", "sceneTaxonomy"));

function rebuildTagStatistics() {
  console.log("🚀 开始重建 tag_statistics...");

  db.prepare("BEGIN TRANSACTION").run();
  try {
    db.prepare("DELETE FROM tag_statistics").run();

    const now = Date.now();

    // 1. Object 标签统计：基于 media_objects.label，经 taxonomy 归一
    const objectRows = db
      .prepare(
        `
        SELECT label, COUNT(*) AS cnt
        FROM media_objects
        GROUP BY label
      `,
      )
      .all();
    const insertTag = db.prepare(
      `
        INSERT INTO tag_statistics (tag_type, tag_name, count, last_updated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tag_type, tag_name) DO UPDATE SET
          count = excluded.count,
          last_updated = excluded.last_updated
      `,
    );

    for (const row of objectRows) {
      const raw = row.label;
      if (!raw) continue;
      const { canonical } = mapObjectLabel(String(raw));
      const name = canonical || String(raw);
      insertTag.run("object", name, row.cnt, now);
    }

    // 2. Scene 标签统计：基于 media_analysis.scene_primary，经 taxonomy 归一
    const sceneRows = db
      .prepare(
        `
        SELECT scene_primary AS scene, COUNT(*) AS cnt
        FROM media_analysis
        WHERE scene_primary IS NOT NULL AND TRIM(scene_primary) != ''
        GROUP BY scene_primary
      `,
      )
      .all();

    for (const row of sceneRows) {
      const raw = row.scene;
      if (!raw) continue;
      const { canonical } = mapSceneLabel(String(raw));
      const name = canonical || String(raw);
      insertTag.run("scene", name, row.cnt, now);
    }

    // 3. Keyword 统计：基于 media_captions.keywords_json（JSON 数组）
    const captionRows = db
      .prepare(
        `
        SELECT keywords_json
        FROM media_captions
        WHERE keywords_json IS NOT NULL AND TRIM(keywords_json) != ''
      `,
      )
      .all();

    const keywordCounts = new Map();
    for (const row of captionRows) {
      try {
        const arr = JSON.parse(row.keywords_json);
        if (!Array.isArray(arr)) continue;
        for (const kw of arr) {
          if (!kw || typeof kw !== "string") continue;
          const key = kw.trim();
          if (!key) continue;
          keywordCounts.set(key, (keywordCounts.get(key) || 0) + 1);
        }
      } catch {
        // ignore parse errors
      }
    }
    for (const [name, cnt] of keywordCounts.entries()) {
      insertTag.run("keyword", name, cnt, now);
    }

    db.prepare("COMMIT").run();
    console.log("🎉 tag_statistics 重建完成！");
  } catch (err) {
    db.prepare("ROLLBACK").run();
    console.error("❌ 重建 tag_statistics 失败:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  rebuildTagStatistics();
}

module.exports = { rebuildTagStatistics };

