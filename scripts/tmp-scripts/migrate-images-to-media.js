/*
 * @Description: images -> media 数据迁移脚本（可重跑）
 * @Usage: node scripts/tmp-scripts/migrate-images-to-media.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  createTableMedia,
  createTableMediaAnalysis,
  createTableMediaCaptions,
  createTableMediaTextBlocks,
  createTableMediaFaceEmbeddings,
  createTableMediaEmbeddings,
  createTableVideoKeyframes,
  createTableVideoTranscripts,
  createTableMediaSearch,
  createTableMediaFts,
  createTableMediaSearchTerms,
  createTableAlbumMedia,
} = require(path.join(projectRoot, "src", "models", "initTableModel"));
const { buildMediaSearchTermRows } = require(path.join(projectRoot, "src", "utils", "searchTermUtils"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((c) => c.name === column);
}

function normalizeMediaType(type) {
  return type === "video" ? "video" : "image";
}

function parseCommaList(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function listToJson(input) {
  const arr = parseCommaList(input);
  return arr.length > 0 ? JSON.stringify(arr) : null;
}

function ensureAlbumsCoverMediaColumn() {
  if (!tableExists("albums")) return;
  if (!columnExists("albums", "cover_media_id")) {
    db.prepare("ALTER TABLE albums ADD COLUMN cover_media_id INTEGER").run();
  }
}

function ensureSimilarMediaColumns() {
  if (tableExists("similar_groups") && !columnExists("similar_groups", "primary_media_id")) {
    db.prepare("ALTER TABLE similar_groups ADD COLUMN primary_media_id INTEGER").run();
  }
  if (tableExists("similar_group_members") && !columnExists("similar_group_members", "media_id")) {
    db.prepare("ALTER TABLE similar_group_members ADD COLUMN media_id INTEGER").run();
  }
}

function ensureFaceClusterRepresentativeType() {
  if (!tableExists("face_clusters")) return;
  if (!columnExists("face_clusters", "representative_type")) {
    db.prepare("ALTER TABLE face_clusters ADD COLUMN representative_type INTEGER DEFAULT 0").run();
  }
}

function ensureFaceClustersForeignKeyToMedia() {
  if (!tableExists("face_clusters")) return;
  if (!tableExists("media_face_embeddings")) {
    throw new Error("未找到 media_face_embeddings，无法修复 face_clusters 外键");
  }

  const fkRows = db.prepare("PRAGMA foreign_key_list(face_clusters)").all();
  const embeddingFk = fkRows.find((row) => row.from === "face_embedding_id");
  if (embeddingFk?.table === "media_face_embeddings") {
    return;
  }

  const hasIsRepresentative = columnExists("face_clusters", "is_representative");
  const hasIsUserAssigned = columnExists("face_clusters", "is_user_assigned");
  const hasRepresentativeType = columnExists("face_clusters", "representative_type");
  const isRepresentativeExpr = hasIsRepresentative ? "COALESCE(is_representative, 0)" : "0";
  const isUserAssignedExpr = hasIsUserAssigned ? "COALESCE(is_user_assigned, 0)" : "0";
  const representativeTypeExpr = hasRepresentativeType
    ? "COALESCE(representative_type, 0)"
    : `CASE
         WHEN ${isRepresentativeExpr} = 2 THEN 2
         WHEN ${isRepresentativeExpr} = 1 THEN 1
         WHEN ${isUserAssignedExpr} = 1 THEN 2
         ELSE 0
       END`;

  db.prepare("DROP TABLE IF EXISTS face_clusters__migrate_new").run();
  db.prepare(`
    CREATE TABLE face_clusters__migrate_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cluster_id INTEGER NOT NULL,
      face_embedding_id INTEGER NOT NULL,
      similarity_score REAL,
      is_representative BOOLEAN DEFAULT FALSE,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      name TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      is_user_assigned BOOLEAN DEFAULT FALSE,
      representative_type INTEGER DEFAULT 0,
      FOREIGN KEY (face_embedding_id) REFERENCES media_face_embeddings(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, cluster_id, face_embedding_id)
    )
  `).run();
  db.prepare(`
    INSERT INTO face_clusters__migrate_new (
      id,
      user_id,
      cluster_id,
      face_embedding_id,
      similarity_score,
      is_representative,
      created_at,
      name,
      updated_at,
      is_user_assigned,
      representative_type
    )
    SELECT
      id,
      user_id,
      cluster_id,
      face_embedding_id,
      similarity_score,
      ${isRepresentativeExpr},
      created_at,
      name,
      updated_at,
      ${isUserAssignedExpr},
      ${representativeTypeExpr}
    FROM face_clusters
  `).run();
  db.prepare("DROP TABLE face_clusters").run();
  db.prepare("ALTER TABLE face_clusters__migrate_new RENAME TO face_clusters").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_user_id ON face_clusters(user_id)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_id ON face_clusters(cluster_id)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_user ON face_clusters(cluster_id, user_id)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_embedding_cluster ON face_clusters(face_embedding_id, cluster_id)").run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_face_clusters_user_cluster_rep ON face_clusters(user_id, cluster_id, representative_type DESC, similarity_score DESC)",
  ).run();
}

function createNewSchema() {
  createTableMedia();
  createTableMediaAnalysis();
  createTableMediaCaptions();
  createTableMediaTextBlocks();
  createTableMediaFaceEmbeddings();
  createTableMediaEmbeddings();
  createTableVideoKeyframes();
  createTableVideoTranscripts();
  createTableMediaSearch();
  createTableMediaFts();
  createTableMediaSearchTerms();
  createTableAlbumMedia();

  // 确保 media_embeddings 具备 UPSERT 所需唯一约束
  db.prepare("DROP INDEX IF EXISTS idx_media_embeddings_media_model_source").run();
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_media_embeddings_media_model_source
    ON media_embeddings(media_id, model_id, source_type)
  `).run();
}

function migrateMediaRows() {
  const rows = db.prepare("SELECT * FROM images").all();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media (
      id, user_id, original_storage_key, high_res_storage_key, thumbnail_storage_key,
      storage_type, mime, file_size_bytes, file_hash, phash, dhash, media_type,
      width_px, height_px, aspect_ratio, raw_orientation, layout_type, hd_width_px, hd_height_px,
      captured_at, year_key, month_key, date_key, day_key, gps_latitude, gps_longitude, gps_altitude,
      gps_location, country, city, duration_sec, video_codec, ingest_status, deleted_at, created_at, is_favorite
    ) VALUES (
      @id, @user_id, @original_storage_key, @high_res_storage_key, @thumbnail_storage_key,
      @storage_type, @mime, @file_size_bytes, @file_hash, @phash, @dhash, @media_type,
      @width_px, @height_px, @aspect_ratio, @raw_orientation, @layout_type, @hd_width_px, @hd_height_px,
      @captured_at, @year_key, @month_key, @date_key, @day_key, @gps_latitude, @gps_longitude, @gps_altitude,
      @gps_location, @country, @city, @duration_sec, @video_codec, @ingest_status, @deleted_at, @created_at, @is_favorite
    )
  `);

  for (const row of rows) {
    stmt.run({
      id: row.id,
      user_id: row.user_id,
      original_storage_key: row.original_storage_key || null,
      high_res_storage_key: row.high_res_storage_key || null,
      thumbnail_storage_key: row.thumbnail_storage_key || null,
      storage_type: row.storage_type || null,
      mime: row.mime || null,
      file_size_bytes: row.file_size_bytes || null,
      file_hash: row.image_hash || null,
      phash: row.image_phash || null,
      dhash: row.image_dhash || null,
      media_type: normalizeMediaType(row.media_type),
      width_px: row.width_px || null,
      height_px: row.height_px || null,
      aspect_ratio: row.aspect_ratio || null,
      raw_orientation: row.raw_orientation || null,
      layout_type: row.layout_type || null,
      hd_width_px: row.hd_width_px || null,
      hd_height_px: row.hd_height_px || null,
      captured_at: row.image_created_at || null,
      year_key: row.year_key || "unknown",
      month_key: row.month_key || "unknown",
      date_key: row.date_key || "unknown",
      day_key: row.day_key || "unknown",
      gps_latitude: row.gps_latitude || null,
      gps_longitude: row.gps_longitude || null,
      gps_altitude: row.gps_altitude || null,
      gps_location: row.gps_location || null,
      country: row.country || null,
      city: row.city || null,
      duration_sec: row.duration_sec || null,
      video_codec: row.video_codec || null,
      ingest_status: "pending",
      deleted_at: row.deleted_at || null,
      created_at: row.created_at || null,
      is_favorite: row.is_favorite || 0,
    });
  }
}

function migrateMediaAnalysisBase() {
  db.prepare(`
    INSERT OR IGNORE INTO media_analysis (media_id, analysis_status, analysis_version)
    SELECT id, 'pending', '1.0'
    FROM media
  `).run();

  db.prepare(`
    UPDATE media_analysis
    SET
      aesthetic_score = (SELECT i.aesthetic_score FROM images i WHERE i.id = media_analysis.media_id),
      sharpness_score = (SELECT i.sharpness_score FROM images i WHERE i.id = media_analysis.media_id),
      is_blurry = COALESCE((SELECT i.is_blurry FROM images i WHERE i.id = media_analysis.media_id), 0),
      face_count = COALESCE((SELECT i.face_count FROM images i WHERE i.id = media_analysis.media_id), 0),
      person_count = COALESCE((SELECT i.person_count FROM images i WHERE i.id = media_analysis.media_id), 0),
      primary_face_quality = (SELECT i.primary_face_quality FROM images i WHERE i.id = media_analysis.media_id),
      primary_expression_confidence = (SELECT i.primary_expression_confidence FROM images i WHERE i.id = media_analysis.media_id)
  `).run();
}

function migrateAiDetailRows() {
  const rows = db.prepare("SELECT * FROM images").all();
  const insertCaption = db.prepare(`
    INSERT INTO media_captions (
      media_id, source_type, source_ref_id, language, caption, keywords_json, analysis_version, created_at
    ) VALUES (?, 'image', NULL, 'auto', ?, ?, ?, ?)
  `);
  const insertText = db.prepare(`
    INSERT INTO media_text_blocks (
      media_id, source_type, text, analysis_version, created_at
    ) VALUES (?, 'ocr', ?, ?, ?)
  `);

  db.prepare("DELETE FROM media_captions").run();
  db.prepare("DELETE FROM media_text_blocks").run();

  for (const row of rows) {
    const version = row.analysis_version || "1.0";
    const createdAt = row.created_at || Date.now();
    const caption = row.alt_text && row.alt_text.trim() ? row.alt_text : null;
    const keywordsJson = listToJson(row.keywords);
    if (caption || keywordsJson) {
      insertCaption.run(row.id, caption, keywordsJson, version, createdAt);
    }

    if (row.ocr_text && row.ocr_text.trim()) {
      insertText.run(row.id, row.ocr_text.trim(), version, createdAt);
    }
  }
}

function migrateEmbeddings() {
  if (tableExists("image_embeddings")) {
    db.prepare("DELETE FROM media_embeddings").run();
    db.prepare(`
      INSERT INTO media_embeddings (
        media_id, source_type, source_ref_id, vector, model_id, created_at, analysis_version
      )
      SELECT image_id, 'image', NULL, vector, model_id, created_at, '1.0'
      FROM image_embeddings
    `).run();
  }

  if (tableExists("face_embeddings")) {
    const rows = db.prepare("SELECT * FROM face_embeddings").all();
    db.prepare("DELETE FROM media_face_embeddings").run();
    const stmt = db.prepare(`
      INSERT INTO media_face_embeddings (
        id, media_id, source_type, source_ref_id, face_index, embedding, age, gender, expression,
        confidence, quality_score, bbox, pose, ignored_for_clustering, face_thumbnail_storage_key,
        created_at, analysis_version
      ) VALUES (
        @id, @media_id, 'image', NULL, @face_index, @embedding, @age, @gender, @expression,
        @confidence, @quality_score, @bbox, @pose, @ignored_for_clustering, @face_thumbnail_storage_key,
        @created_at, @analysis_version
      )
    `);
    for (const row of rows) {
      stmt.run({
        id: row.id,
        media_id: row.image_id,
        face_index: row.face_index,
        embedding: row.embedding,
        age: row.age || null,
        gender: row.gender || null,
        expression: row.expression || null,
        confidence: row.confidence || null,
        quality_score: row.quality_score || null,
        bbox: row.bbox || null,
        pose: row.pose || null,
        ignored_for_clustering: row.ignored_for_clustering || 0,
        face_thumbnail_storage_key: row.face_thumbnail_storage_key || null,
        created_at: row.created_at || Date.now(),
        analysis_version: "1.0",
      });
    }
  }
}

function migrateAlbumAndGroupRefs() {
  if (tableExists("album_images")) {
    db.prepare("DELETE FROM album_media").run();
    db.prepare(`
      INSERT OR IGNORE INTO album_media (album_id, media_id, added_at)
      SELECT album_id, image_id, added_at FROM album_images
    `).run();
  }

  ensureAlbumsCoverMediaColumn();
  if (columnExists("albums", "cover_image_id")) {
    db.prepare("UPDATE albums SET cover_media_id = cover_image_id WHERE cover_image_id IS NOT NULL").run();
  }

  ensureSimilarMediaColumns();
  if (columnExists("similar_groups", "primary_image_id")) {
    db.prepare("UPDATE similar_groups SET primary_media_id = primary_image_id WHERE primary_image_id IS NOT NULL").run();
  }
  if (columnExists("similar_group_members", "image_id")) {
    db.prepare("UPDATE similar_group_members SET media_id = image_id WHERE image_id IS NOT NULL").run();
  }

  ensureFaceClusterRepresentativeType();
  const hasUserAssigned = columnExists("face_clusters", "is_user_assigned");
  const hasRepresentative = columnExists("face_clusters", "is_representative");
  if (hasUserAssigned || hasRepresentative) {
    db.prepare(`
      UPDATE face_clusters
      SET representative_type =
        CASE
          WHEN ${hasUserAssigned ? "COALESCE(is_user_assigned, 0) = 1" : "0"} THEN 2
          WHEN ${hasRepresentative ? "COALESCE(is_representative, 0) = 1" : "0"} THEN 1
          ELSE 0
        END
    `).run();
  }

  ensureFaceClustersForeignKeyToMedia();
}

function rebuildMediaSearchData() {
  db.prepare("DELETE FROM media_search").run();
  db.prepare("DELETE FROM media_search_terms").run();
  db.prepare(`
    INSERT INTO media_search (
      media_id, user_id, caption_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_text, transcript_text, updated_at
    )
    SELECT
      m.id AS media_id,
      m.user_id,
      (
        SELECT GROUP_CONCAT(c.caption, ' ')
        FROM media_captions c
        WHERE c.media_id = m.id
      ) AS caption_text,
      (
        SELECT GROUP_CONCAT(j.value, ' ')
        FROM media_captions c, json_each(c.keywords_json) j
        WHERE c.media_id = m.id
      ) AS keywords_text,
      (
        SELECT GROUP_CONCAT(j.value, ' ')
        FROM media_captions c, json_each(c.subject_tags_json) j
        WHERE c.media_id = m.id
      ) AS subject_tags_text,
      (
        SELECT GROUP_CONCAT(j.value, ' ')
        FROM media_captions c, json_each(c.action_tags_json) j
        WHERE c.media_id = m.id
      ) AS action_tags_text,
      (
        SELECT GROUP_CONCAT(j.value, ' ')
        FROM media_captions c, json_each(c.scene_tags_json) j
        WHERE c.media_id = m.id
      ) AS scene_tags_text,
      (
        SELECT GROUP_CONCAT(t.text, ' ')
        FROM media_text_blocks t
        WHERE t.media_id = m.id
      ) AS ocr_text,
      (
        SELECT GROUP_CONCAT(vt.transcript_text, ' ')
        FROM video_transcripts vt
        WHERE vt.media_id = m.id
      ) AS transcript_text,
      (strftime('%s','now') * 1000) AS updated_at
    FROM media m
    WHERE m.deleted_at IS NULL
  `).run();

  const rows = db.prepare(`
    SELECT media_id, user_id, caption_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_text, transcript_text, updated_at
    FROM media_search
  `).all();
  const insertTermStmt = db.prepare(`
    INSERT INTO media_search_terms (
      media_id, user_id, field_type, term, term_len, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const termRows = buildMediaSearchTermRows({
      mediaId: row.media_id,
      userId: row.user_id,
      fields: {
        caption: row.caption_text,
        keywords: row.keywords_text,
        subject_tags: row.subject_tags_text,
        action_tags: row.action_tags_text,
        scene_tags: row.scene_tags_text,
        ocr: row.ocr_text,
        transcript: row.transcript_text,
      },
      updatedAt: row.updated_at,
    });
    for (const termRow of termRows) {
      insertTermStmt.run(
        termRow.mediaId,
        termRow.userId,
        termRow.fieldType,
        termRow.term,
        termRow.termLen,
        termRow.updatedAt,
      );
    }
  }
}

function updateAnalysisStatus() {
  db.prepare(`
    UPDATE media_analysis
    SET
      has_ocr = CASE WHEN EXISTS (SELECT 1 FROM media_text_blocks t WHERE t.media_id = media_analysis.media_id) THEN 1 ELSE 0 END,
      has_caption = CASE WHEN EXISTS (SELECT 1 FROM media_captions c WHERE c.media_id = media_analysis.media_id) THEN 1 ELSE 0 END
  `).run();

  db.prepare(`
    UPDATE media_analysis
    SET
      analysis_status = CASE
        WHEN
          EXISTS (SELECT 1 FROM media_captions c WHERE c.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_text_blocks t WHERE t.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_face_embeddings f WHERE f.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = media_analysis.media_id)
        THEN 'done'
        ELSE 'pending'
      END,
      analyzed_at = CASE
        WHEN
          EXISTS (SELECT 1 FROM media_captions c WHERE c.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_text_blocks t WHERE t.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_face_embeddings f WHERE f.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.media_id = media_analysis.media_id)
          OR EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = media_analysis.media_id)
        THEN (strftime('%s','now') * 1000)
        ELSE analyzed_at
      END
  `).run();
}

function migrate() {
  if (!tableExists("images")) {
    throw new Error("未找到 images 表，无法执行 images -> media 迁移");
  }

  console.log("🚀 开始执行 images -> media 迁移...");
  db.prepare("BEGIN").run();
  try {
    createNewSchema();
    migrateMediaRows();
    migrateMediaAnalysisBase();
    migrateAiDetailRows();
    migrateEmbeddings();
    migrateAlbumAndGroupRefs();
    updateAnalysisStatus();
    rebuildMediaSearchData();
    db.prepare("COMMIT").run();
    console.log("✅ 迁移完成（可重跑）");
  } catch (error) {
    db.prepare("ROLLBACK").run();
    throw error;
  }
}

if (require.main === module) {
  try {
    migrate();
  } catch (error) {
    console.error("❌ 迁移失败:", error.message);
    process.exit(1);
  }
}

module.exports = { migrate };
