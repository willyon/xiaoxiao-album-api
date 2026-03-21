/**
 * 数据库表结构定义与创建
 * 所有业务表均以 media 为核心（媒体、相册、人脸聚类、相似组等）；AI 文案与 OCR 在 media 的 ai_* 列，由 rebuild-database.js 按依赖顺序调用创建。
 */
const { db } = require("../services/database");

/** 删除 users 表（慎用，会级联影响依赖表） */
function deleteTableUsers() {
  const createtablestmt = `
    DROP TABLE users
  `;
  db.prepare(createtablestmt).run();
}

/** 创建 users 表：用户账号、验证状态等 */
function createTableUsers() {
  const createtablestmt = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      verified_status TEXT DEFAULT 'pending',
      verification_token TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
  `;
  try {
    db.prepare(createtablestmt).run();
  } catch (err) {
    console.error("创建 users 表失败：", err.message);
    throw err;
  }
}

/** 创建 face_cluster_representatives：每人脸聚类一条代表向量，用于增量/全量人脸匹配 */
function createTableFaceClusterRepresentatives() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS face_cluster_representatives (
        user_id INTEGER NOT NULL,
        cluster_id INTEGER NOT NULL,
        representative_embedding BLOB NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (user_id, cluster_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.prepare(sql).run();
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_cluster_repr_user_id
      ON face_cluster_representatives(user_id);
    `,
    ).run();
  } catch (err) {
    console.error("创建人脸聚类代表向量表失败：", err.message);
    throw err;
  }
}

/** 创建 face_cluster_meta：每人脸聚类一条，记录 last_used_at 供「最近使用人物」排序 */
function createTableFaceClusterMeta() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS face_cluster_meta (
        user_id INTEGER NOT NULL,
        cluster_id INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, cluster_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.prepare(sql).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_cluster_meta_user_last_used
      ON face_cluster_meta(user_id, last_used_at DESC);
    `
    ).run();
  } catch (err) {
    console.error("创建 face_cluster_meta 表失败：", err.message);
    throw err;
  }
}

/** 创建 media 表：图片/视频元数据、存储 key、时间/地理/尺寸等，唯一约束 (user_id, file_hash) */
function createTableMedia() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      original_storage_key TEXT,
      high_res_storage_key TEXT,
      thumbnail_storage_key TEXT,
      mime TEXT,
      file_size_bytes INTEGER,
      file_hash TEXT,
      phash TEXT,
      dhash TEXT,
      media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video')),
      width_px INTEGER,
      height_px INTEGER,
      aspect_ratio REAL,
      raw_orientation INTEGER,
      layout_type TEXT,
      hd_width_px INTEGER,
      hd_height_px INTEGER,
      captured_at INTEGER,
      year_key TEXT DEFAULT 'unknown',
      month_key TEXT DEFAULT 'unknown',
      date_key TEXT DEFAULT 'unknown',
      day_key TEXT DEFAULT 'unknown',
      gps_latitude REAL,
      gps_longitude REAL,
      gps_altitude REAL,
      gps_location TEXT,
      country TEXT,
      city TEXT,
      duration_sec REAL,
      video_codec TEXT,
      ingest_status TEXT DEFAULT 'pending' CHECK (ingest_status IN ('pending','processing','ready','failed')),
      deleted_at INTEGER,
      created_at INTEGER,
      is_favorite INTEGER DEFAULT 0 NOT NULL,
      ai_description TEXT,
      ai_keywords_json TEXT,
      ai_subject_tags_json TEXT,
      ai_action_tags_json TEXT,
      ai_scene_tags_json TEXT,
      ai_ocr_text TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, file_hash)
    );
  `;
  db.prepare(sql).run();

  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_captured_at ON media(user_id, captured_at DESC, id DESC);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_date_key ON media(user_id, date_key);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_city ON media(user_id, city) WHERE city IS NOT NULL AND city != '';").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_deleted ON media(user_id, deleted_at);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_type ON media(user_id, media_type);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_user_favorite ON media(user_id, is_favorite);").run();
}

/** 创建 media_analysis：单条媒体分析状态与结果（美学/清晰度/人脸/OCR等） */
function createTableMediaAnalysis() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media_analysis (
      media_id INTEGER PRIMARY KEY,
      analysis_status TEXT DEFAULT 'pending' CHECK (analysis_status IN ('pending','running','done','failed')),
      analysis_version TEXT NOT NULL DEFAULT '1.0',
      analyzed_at INTEGER,
      last_error TEXT,
      last_error_at INTEGER,
      aesthetic_score REAL,
      sharpness_score REAL,
      is_blurry INTEGER DEFAULT 0,
      face_count INTEGER DEFAULT 0,
      person_count INTEGER DEFAULT 0,
      primary_face_quality REAL,
      primary_expression TEXT,
      primary_expression_confidence REAL,
      has_ocr INTEGER DEFAULT 0,
      has_description INTEGER DEFAULT 0,
      environment TEXT,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_analysis_status_face ON media_analysis(analysis_status, face_count);").run();
}

/** 创建 video_keyframes：视频关键帧及存储 key */
function createTableVideoKeyframes() {
  const sql = `
    CREATE TABLE IF NOT EXISTS video_keyframes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      width_px INTEGER,
      height_px INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      analysis_version TEXT,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_keyframes_video ON video_keyframes(media_id, timestamp_ms);").run();
}

/** 创建 video_transcripts：视频转写文本与词级数据 */
function createTableVideoTranscripts() {
  const sql = `
    CREATE TABLE IF NOT EXISTS video_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      language TEXT,
      transcript_text TEXT,
      words_json TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      analysis_version TEXT,
      model_id TEXT,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_transcript_video ON video_transcripts(media_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_transcript_version ON video_transcripts(analysis_version);").run();
}

/** 创建 media_face_embeddings：单条人脸向量，关联 media，用于人脸聚类与检索 */
function createTableMediaFaceEmbeddings() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media_face_embeddings (
      id INTEGER PRIMARY KEY,
      media_id INTEGER NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'image',
      source_ref_id INTEGER,
      face_index INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      age INTEGER,
      gender TEXT,
      expression TEXT,
      confidence REAL,
      quality_score REAL,
      bbox TEXT,
      pose TEXT,
      ignored_for_clustering BOOLEAN DEFAULT FALSE,
      face_thumbnail_storage_key TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      analysis_version TEXT,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
      UNIQUE (media_id, source_type, source_ref_id, face_index)
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_media_id ON media_face_embeddings(media_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_age ON media_face_embeddings(age);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_gender ON media_face_embeddings(gender);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_expression ON media_face_embeddings(expression);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_face_embeddings_ignored ON media_face_embeddings(ignored_for_clustering);").run();
}

/** 创建 media_embeddings：媒体级向量（非人脸），按 model_id/source_type 唯一 */
function createTableMediaEmbeddings() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_ref_id INTEGER,
      vector BLOB NOT NULL,
      model_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      analysis_version TEXT,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
      UNIQUE (media_id, model_id, source_type)
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_media_embeddings_media_model_source ON media_embeddings(media_id, model_id, source_type);").run();
}

/** 创建 album_media：相册与媒体的多对多关联 */
function createTableAlbumMedia() {
  const sql = `
    CREATE TABLE IF NOT EXISTS album_media (
      album_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      PRIMARY KEY (album_id, media_id),
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_album_media_album_id ON album_media(album_id, added_at DESC);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_album_media_media_id ON album_media(media_id);").run();
}

/** 创建 media_search：汇总 caption/OCR/转写等，供搜索与 FTS 同步（ocr_text 为 OCR 原文；ocr_search_terms 为 OCR 的 jieba；caption_search_terms 为图片理解 jieba） */
function createTableMediaSearch() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media_search (
      media_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      description_text TEXT,
      keywords_text TEXT,
      subject_tags_text TEXT,
      action_tags_text TEXT,
      scene_tags_text TEXT,
      ocr_text TEXT,
      ocr_search_terms TEXT,
      transcript_text TEXT,
      caption_search_terms TEXT,
      updated_at INTEGER,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_user_id ON media_search(user_id);").run();
}

/** 创建 media_search_fts：FTS5 虚拟表，与 media_search 内容同步，用于全文检索（会先 DROP 旧表以便列名变更后重建） */
function createTableMediaSearchFts() {
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();
  db.prepare("DROP TABLE IF EXISTS media_search_fts").run();
  const sql = `
    CREATE VIRTUAL TABLE media_search_fts USING fts5(
      description_text,
      keywords_text,
      subject_tags_text,
      action_tags_text,
      scene_tags_text,
      ocr_search_terms,
      transcript_text,
      caption_search_terms,
      content='media_search',
      content_rowid='media_id'
    );
  `;
  db.prepare(sql).run();
  createTableMediaSearchFtsTriggers();
}

/** 创建 media_search -> media_search_fts 同步触发器，INSERT/UPDATE/DELETE 时自动增量更新 FTS */
function createTableMediaSearchFtsTriggers() {
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ai").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_ad").run();
  db.prepare("DROP TRIGGER IF EXISTS media_search_fts_au").run();

  db.prepare(`
    CREATE TRIGGER media_search_fts_ai AFTER INSERT ON media_search BEGIN
      INSERT INTO media_search_fts(rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_search_terms, transcript_text, caption_search_terms)
      VALUES (new.media_id, new.description_text, new.keywords_text, new.subject_tags_text, new.action_tags_text, new.scene_tags_text, new.ocr_search_terms, new.transcript_text, new.caption_search_terms);
    END
  `).run();

  db.prepare(`
    CREATE TRIGGER media_search_fts_ad AFTER DELETE ON media_search BEGIN
      INSERT INTO media_search_fts(media_search_fts, rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_search_terms, transcript_text, caption_search_terms)
      VALUES ('delete', old.media_id, old.description_text, old.keywords_text, old.subject_tags_text, old.action_tags_text, old.scene_tags_text, old.ocr_search_terms, old.transcript_text, old.caption_search_terms);
    END
  `).run();

  db.prepare(`
    CREATE TRIGGER media_search_fts_au AFTER UPDATE ON media_search BEGIN
      INSERT INTO media_search_fts(media_search_fts, rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_search_terms, transcript_text, caption_search_terms)
      VALUES ('delete', old.media_id, old.description_text, old.keywords_text, old.subject_tags_text, old.action_tags_text, old.scene_tags_text, old.ocr_search_terms, old.transcript_text, old.caption_search_terms);
      INSERT INTO media_search_fts(rowid, description_text, keywords_text, subject_tags_text, action_tags_text, scene_tags_text, ocr_search_terms, transcript_text, caption_search_terms)
      VALUES (new.media_id, new.description_text, new.keywords_text, new.subject_tags_text, new.action_tags_text, new.scene_tags_text, new.ocr_search_terms, new.transcript_text, new.caption_search_terms);
    END
  `).run();
}

/** 创建 media_search_terms：中文 term 索引，用于单字/双字稳定召回 */
function createTableMediaSearchTerms() {
  const sql = `
    CREATE TABLE IF NOT EXISTS media_search_terms (
      media_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      field_type TEXT NOT NULL,
      term TEXT NOT NULL,
      term_len INTEGER NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (media_id, field_type, term),
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_terms_user_term ON media_search_terms(user_id, term);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_terms_media_id ON media_search_terms(media_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_media_search_terms_user_field_term ON media_search_terms(user_id, field_type, term);").run();
}

/** 创建 albums 表（media 版）：相册名、封面 cover_media_id、软删除、last_used_at */
function createTableAlbumsMediaVersion() {
  const sql = `
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cover_media_id INTEGER,
      image_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      last_used_at INTEGER,
      deleted_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE SET NULL
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_albums_user_id ON albums(user_id);").run();
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_user_name_unique ON albums(user_id, name) WHERE deleted_at IS NULL;").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_albums_user_created ON albums(user_id, created_at DESC);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_albums_user_deleted ON albums(user_id, deleted_at) WHERE deleted_at IS NULL;").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_albums_user_last_used ON albums(user_id, last_used_at DESC) WHERE deleted_at IS NULL;").run();
}

/** 创建 face_clusters：用户人脸聚类，关联 media_face_embeddings，含代表向量与名称 */
function createTableFaceClustersMediaVersion() {
  const sql = `
    CREATE TABLE IF NOT EXISTS face_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cluster_id INTEGER NOT NULL,
      face_embedding_id INTEGER NOT NULL,
      similarity_score REAL,
      representative_type INTEGER DEFAULT 0,
      name TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (face_embedding_id) REFERENCES media_face_embeddings(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, cluster_id, face_embedding_id)
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_user_id ON face_clusters(user_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_id ON face_clusters(cluster_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_user ON face_clusters(cluster_id, user_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_embedding_cluster ON face_clusters(face_embedding_id, cluster_id);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_face_clusters_user_cluster_rep ON face_clusters(user_id, cluster_id, representative_type DESC, similarity_score DESC);").run();
}

/** 创建 similar_groups：相似图分组，primary_media_id 指向 media */
function createTableSimilarGroupsMediaVersion() {
  const sql = `
    CREATE TABLE IF NOT EXISTS similar_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_type TEXT NOT NULL,
      primary_media_id INTEGER,
      member_count INTEGER DEFAULT 0,
      total_size_bytes INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (primary_media_id) REFERENCES media(id) ON DELETE SET NULL
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_groups_user_type ON similar_groups(user_id, group_type);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_groups_user_updated ON similar_groups(user_id, updated_at DESC);").run();
}

/** 创建 similar_group_members：相似组成员，group_id + media_id */
function createTableSimilarGroupMembersMediaVersion() {
  const sql = `
    CREATE TABLE IF NOT EXISTS similar_group_members (
      group_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      rank_score REAL,
      similarity REAL,
      aesthetic_score REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      PRIMARY KEY (group_id, media_id),
      FOREIGN KEY (group_id) REFERENCES similar_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    );
  `;
  db.prepare(sql).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_members_group_rank ON similar_group_members(group_id, rank_score DESC);").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_similar_members_media ON similar_group_members(media_id);").run();
}

module.exports = {
  deleteTableUsers,
  createTableUsers,
  createTableFaceClusterRepresentatives,
  createTableFaceClusterMeta,
  createTableMedia,
  createTableMediaAnalysis,
  createTableMediaFaceEmbeddings,
  createTableMediaEmbeddings,
  createTableVideoKeyframes,
  createTableVideoTranscripts,
  createTableMediaSearch,
  createTableMediaSearchFts,
  createTableMediaSearchTerms,
  createTableAlbumMedia,
  createTableAlbumsMediaVersion,
  createTableFaceClustersMediaVersion,
  createTableSimilarGroupsMediaVersion,
  createTableSimilarGroupMembersMediaVersion,
};
