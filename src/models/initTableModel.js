/*
 * @Author: zhangshouchang
 * @Date: 2025-08-13 09:10:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 14:46:14
 * @Description: File description
 */
const { db } = require("../services/database");
//删除users表格
function deleteTableUsers() {
  const createtablestmt = `
    DROP TABLE users
  `;
  db.prepare(createtablestmt).run();
}

//创建users表格
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

//删除images表格
function deleteTableImages() {
  const createtablestmt = `
    DROP TABLE images
  `;
  db.prepare(createtablestmt).run();
}

// 创建images表格（带物化年月与索引优化）
// 外键（FOREIGN KEY）的作用是为了：
// 	•	数据一致性（防止插入无效的 user_id） 只有当这个user_id在users 表中有对应的id时 才允许插入这条数据
// 	•	级联操作支持（比如删除用户时自动删掉图片）
function createTableImages() {
  try {
    // 1) 表结构
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        original_storage_key TEXT,
        high_res_storage_key TEXT,
        thumbnail_storage_key TEXT,
        image_created_at INTEGER,              -- 毫秒时间戳，可为 NULL
        image_hash TEXT,                   -- 图片内容哈希
        image_phash TEXT,                  -- 感知哈希（pHash，十六进制字符串）
        image_dhash TEXT,                  -- 差分哈希（dHash，十六进制字符串）
        year_key  TEXT DEFAULT 'unknown',                     -- 物化：'YYYY' 或 'unknown'
        month_key TEXT DEFAULT 'unknown',                     -- 物化：'YYYY-MM' 或 'unknown'
        date_key TEXT  DEFAULT 'unknown',                     -- 物化：'YYYY-MM-DD' 或 'unknown'
        day_key TEXT   DEFAULT 'unknown',                     -- 物化：'Monday' ... 或 'unknown'
        
        -- GPS 位置信息
        gps_latitude REAL,                  -- GPS纬度 (十进制格式) REAL 浮点数类型
        gps_longitude REAL,                 -- GPS经度 (十进制格式) REAL 浮点数类型
        gps_altitude REAL,                  -- GPS海拔 (米) REAL 浮点数类型
        gps_location TEXT,                  -- 位置描述 (可选，用于显示)
        country TEXT,                       -- 国家 (物化字段，用于分组查询)
        city TEXT,                          -- 城市 (物化字段，用于分组查询)
        
        -- 图片尺寸和方向信息
        width_px INTEGER,                   -- 旋正后的原图宽度
        height_px INTEGER,                  -- 旋正后的原图高度
        aspect_ratio REAL,                  -- 宽高比 (width_px / height_px)
        raw_orientation INTEGER,            -- EXIF Orientation 原值 1-8
        layout_type TEXT, -- 方向分类: 'portrait' | 'landscape' | 'square' | 'panorama' | null
        
        -- 高清图和缩略图尺寸
        hd_width_px INTEGER,                -- 高清图实际宽度
        hd_height_px INTEGER,               -- 高清图实际高度
        
        -- 存储类型信息
        storage_type TEXT,  -- 存储类型：'local', 'aliyun-oss', 's3', 'qiniu', 'cos', 'bos', 'gcs', 'azure'
        
        -- 文件信息
        file_size_bytes INTEGER,            -- 文件大小（字节）
        mime TEXT,                          -- MIME类型: 'image/jpeg' | 'image/heic' | 'image/png' | 'image/webp'
        
        -- 颜色主题
        color_theme TEXT DEFAULT 'neutral',    -- 颜色主题: 'vibrant' | 'bright' | 'neutral' | 'muted' | 'dim' (鲜艳|明亮|中性|柔和|暗淡)
        
        -- 时间戳信息
        created_at INTEGER,                 -- 缩略图入库时间戳（毫秒）
        deleted_at INTEGER,                 -- 软删除时间戳（毫秒，NULL 表示未删除）

        -- 自然语言搜索字段（AI 内容理解）
        alt_text TEXT DEFAULT NULL,         -- 自动生成的图片描述（NULL=未处理，''=已处理但无描述）
        ocr_text TEXT DEFAULT NULL,         -- OCR识别的文字（NULL=未处理，''=已处理但无文字）
        keywords TEXT DEFAULT NULL,         -- 关键词（NULL=未处理，''=已处理但无关键词）
        scene_tags TEXT DEFAULT NULL,       -- 场景标签（NULL=未处理，''=已处理但无场景）
        object_tags TEXT DEFAULT NULL,      -- 物体标签（NULL=未处理，''=已处理但无物体）
        
        -- 人脸分析字段（v2.0 - AI 人脸识别）
        face_count INTEGER DEFAULT NULL,    -- 人脸数量（NULL=未分析，0=已分析但无人脸，>0=有人脸）
        person_count INTEGER DEFAULT NULL,  -- 人物数量（NULL=未分析，0=已分析但无人物，>0=有人物）
        expression_tags TEXT DEFAULT NULL,  -- 表情标签（NULL=未分析，''=已分析但无表情）
        age_tags TEXT DEFAULT NULL,         -- 年龄段标签（NULL=未分析，''=已分析但无年龄数据）
        gender_tags TEXT DEFAULT NULL,      -- 性别标签（NULL=未分析，''=已分析但无性别数据）
        has_young INTEGER DEFAULT NULL,     -- 是否有儿童（NULL=未分析，0=无儿童，1=有儿童）
        has_adult INTEGER DEFAULT NULL,     -- 是否有成人（NULL=未分析，0=无成人，1=有成人）
        primary_face_quality REAL DEFAULT NULL, -- 主要人脸质量分数（0-1）
        primary_expression_confidence REAL DEFAULT NULL, -- 主要表情置信度（0-1）
        analysis_version TEXT DEFAULT '1.0', -- 分析版本号
        -- 智能清理指标字段
        aesthetic_score REAL DEFAULT NULL,   -- 美学评分（0-1）
        sharpness_score REAL DEFAULT NULL,   -- 清晰度分数（0-1，值越大越清晰，模糊图判断在业务逻辑中进行）
        -- 喜欢状态字段
        is_favorite INTEGER DEFAULT 0 NOT NULL -- 是否已喜欢（0=未喜欢，1=已喜欢）

        -- 同一用户下，内容哈希唯一（避免跨用户互相影响）
        UNIQUE (user_id, image_hash),

        -- 维护级联：删除用户自动删除其图片
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.prepare(createTableSQL).run();

    // 2) 创建核心索引（经过优化的8个核心索引）
    // 2.1 用户基础查询索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_id
      ON images(user_id);
    `,
    ).run();

    // 2.2 哈希重复检查索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_hash
      ON images(image_hash);
    `,
    ).run();

    // 2.3 用户哈希组合索引（用于更新操作）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_hash
      ON images(user_id, image_hash);
    `,
    ).run();

    // 2.4 用户创建时间索引（主要分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_creation_desc
      ON images(user_id, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.5 用户年份创建时间索引（年份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year_creation
      ON images(user_id, year_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.6 用户月份创建时间索引（月份分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month_creation
      ON images(user_id, month_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.7 用户存储类型创建时间索引（存储类型分组查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_storage_creation
      ON images(user_id, storage_type, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.8 用户年份索引（年份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year
      ON images(user_id, year_key);
    `,
    ).run();

    // 2.9 用户月份索引（月份分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month
      ON images(user_id, month_key);
    `,
    ).run();

    // 2.10 用户日期创建时间索引（日期分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_date_creation
      ON images(user_id, date_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.11 用户星期创建时间索引（星期几分页查询）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_day_creation
      ON images(user_id, day_key, image_created_at DESC, id DESC);
    `,
    ).run();

    // 2.12 用户日期索引（日期分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_date
      ON images(user_id, date_key);
    `,
    ).run();

    // 2.13 用户星期索引（星期几分组统计）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_day
      ON images(user_id, day_key);
    `,
    ).run();

    // 2.14 用户国家索引（国家分组统计）- 已纳入 FTS5，无需单独索引
    // db.prepare(
    //   `
    //   CREATE INDEX IF NOT EXISTS idx_images_user_country
    //   ON images(user_id, country);
    // `,
    // ).run();

    // 2.15 用户城市索引（城市分组统计）- 已纳入 FTS5，无需单独索引
    // db.prepare(
    //   `
    //   CREATE INDEX IF NOT EXISTS idx_images_user_city
    //   ON images(user_id, city);
    // `,
    // ).run();

    // 2.16 用户方向索引（方向筛选）- 已纳入 FTS5，无需单独索引
    // db.prepare(
    //   `
    //   CREATE INDEX IF NOT EXISTS idx_images_user_layout_type
    //   ON images(user_id, layout_type);
    // `,
    // ).run();

    // 2.17 用户宽高比索引（宽高比筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_aspect_ratio
      ON images(user_id, aspect_ratio);
    `,
    ).run();

    // 2.18 用户MIME类型索引（文件类型筛选）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_mime
      ON images(user_id, mime);
    `,
    ).run();

    // ==================== 筛选功能专用索引 ====================
    // 2.19 人脸数量筛选索引（用于按人脸数量筛选照片）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_face_count
      ON images(user_id, face_count);
    `,
    ).run();

    // 2.19.1 人物数量筛选索引（用于按人物数量筛选照片，包括背面/远景）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_person_count
      ON images(user_id, person_count);
    `,
    ).run();

    // 2.20 颜色主题筛选索引（用于按颜色主题筛选照片）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_color_theme
      ON images(user_id, color_theme);
    `,
    ).run();

    // 2.21 年龄段筛选复合索引（用于快速筛选儿童/成人照片）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_age_flags
      ON images(user_id, has_young, has_adult);
    `,
    ).run();

    // 2.22 城市筛选索引（虽然city在FTS5中，但精确匹配查询仍需索引）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_city
      ON images(user_id, city)
      WHERE city IS NOT NULL AND city != '';
    `,
    ).run();

    // 2.23 图片版式筛选索引（虽然layout_type在FTS5中，但精确匹配查询仍需索引）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_layout_type
      ON images(user_id, layout_type)
      WHERE layout_type IS NOT NULL;
    `,
    ).run();

    // 2.24 用户美学分数索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_aesthetic
      ON images(user_id, aesthetic_score);
    `,
    ).run();

    // 2.25 用户清晰度索引

    // 2.25.1 用户喜欢状态索引（用于快速查询喜欢的图片）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_is_favorite
      ON images(user_id, is_favorite);
    `,
    ).run();

    // 2.26 感知哈希索引（pHash）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_phash
      ON images(image_phash);
    `,
    ).run();

    // 2.29 差分哈希索引（dHash）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_dhash
      ON images(image_dhash);
      `,
    ).run();

    // 2.30 用户软删除索引（过滤与清理任务）
    // 部分索引：只索引未删除的记录，提高查询效率
    // 由于几乎所有查询都过滤 deleted_at IS NULL，这个索引可以显著提升性能
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_deleted
      ON images(user_id, deleted_at)
      WHERE deleted_at IS NULL;
      `,
    ).run();

    // 2.30.1 回收站查询索引（用于已删除图片查询）
    // 部分索引：只索引已删除的记录（deleted_at IS NOT NULL）
    // 用于回收站页面的分页查询，可以显著提升查询性能
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_deleted_at
      ON images(user_id, deleted_at)
      WHERE deleted_at IS NOT NULL;
      `,
    ).run();

    // 2.20.1 优化年份查询的部分索引（包含 deleted_at 过滤）
    // 用于查询：WHERE user_id = ? AND year_key = ? AND deleted_at IS NULL
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_year_deleted
      ON images(user_id, year_key, image_created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
      `,
    ).run();

    // 2.20.2 优化月份查询的部分索引（包含 deleted_at 过滤）
    // 用于查询：WHERE user_id = ? AND month_key = ? AND deleted_at IS NULL
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_month_deleted
      ON images(user_id, month_key, image_created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
      `,
    ).run();

    // 2.20.3 优化日期查询的部分索引（包含 deleted_at 过滤）
    // 用于查询：WHERE user_id = ? AND date_key = ? AND deleted_at IS NULL
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_user_date_deleted
      ON images(user_id, date_key, image_created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
      `,
    ).run();

    // 注：expression_tags、gender_tags 为逗号分隔字符串，使用 LIKE 查询，索引效果有限，不建立索引

    // 注：人脸相关索引（face_count、has_young、has_adult）已在上面的"筛选功能专用索引"部分创建，无需重复

    // 3) 创建搜索相关索引
    // 3.1 主要人脸质量索引（用于高质量照片筛选和排序）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_images_primary_face_quality
      ON images(primary_face_quality);
`,
    ).run();

    // 4) 创建全文搜索索引（FTS5）
    // 4.1 全文搜索虚拟表
    const ftsSQL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
        alt_text,
        ocr_text,
        keywords,
        scene_tags,
        object_tags,
        expression_tags,
        age_tags,
        gender_tags,
        country,
        city,
        layout_type,
        content='images',
        content_rowid='id'
      );
    `;
    db.prepare(ftsSQL).run();

    // 4.2 FTS 同步触发器
    // 4.2.1 UPDATE 触发器（使用 INSERT OR REPLACE 确保数据同步）
    db.prepare(
      `
      CREATE TRIGGER IF NOT EXISTS images_fts_update AFTER UPDATE ON images BEGIN
        INSERT OR REPLACE INTO images_fts(rowid, alt_text, ocr_text, keywords, scene_tags, object_tags, expression_tags, age_tags, gender_tags, country, city, layout_type)
        VALUES (new.id, new.alt_text, new.ocr_text, new.keywords, new.scene_tags, new.object_tags, new.expression_tags, new.age_tags, new.gender_tags, new.country, new.city, new.layout_type);
      END;
    `,
    ).run();

    // 4.2.3 DELETE 触发器
    db.prepare(
      `
      CREATE TRIGGER IF NOT EXISTS images_fts_delete AFTER DELETE ON images BEGIN
        DELETE FROM images_fts WHERE rowid = old.id;
      END;
    `,
    ).run();
  } catch (err) {
    console.error("创建 images 表失败：", err.message);
    throw err;
  }
}

/**
 * 创建图像向量表（用于通用图像 embedding）
 */
function createTableImageEmbeddings() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS image_embeddings (
        image_id INTEGER PRIMARY KEY,
        vector BLOB NOT NULL,
        model_id TEXT NOT NULL,
        created_at INTEGER,
        FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
      );
    `;
    db.prepare(sql).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_image_embeddings_model
      ON image_embeddings(model_id);
    `,
    ).run();

    console.log("✅ 创建 image_embeddings 表及索引");
  } catch (err) {
    console.error("创建 image_embeddings 表失败：", err.message);
    throw err;
  }
}

/**
 * 创建人脸特征表
 */
function createTableFaceEmbeddings() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS face_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id INTEGER NOT NULL,
        face_index INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        age INTEGER,
        gender TEXT,
        expression TEXT,
        confidence REAL,
        quality_score REAL DEFAULT NULL,        -- 人脸质量分数（0-1，用于选择最佳封面人脸）
        bbox TEXT DEFAULT NULL,                 -- 人脸边界框坐标（JSON格式: [x1, y1, x2, y2]，用于生成缩略图）
        pose TEXT DEFAULT NULL,                 -- 人脸姿态信息（JSON格式: {yaw, pitch, roll}，用于选择最佳封面人脸）
        ignored_for_clustering BOOLEAN DEFAULT FALSE,  -- 是否排除参与聚类（TRUE=永久排除，FALSE/NULL=参与聚类，保留字段以备未来扩展使用）
        face_thumbnail_storage_key TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
        UNIQUE (image_id, face_index)
      );
    `;
    db.prepare(sql).run();
    console.log("✅ 创建人脸特征表");

    // 创建索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_image_id
      ON face_embeddings(image_id);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_age
      ON face_embeddings(age);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_gender
      ON face_embeddings(gender);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_expression
      ON face_embeddings(expression);
    `,
    ).run();

    console.log("✅ 创建人脸特征表索引");
  } catch (err) {
    console.error("创建人脸特征表失败：", err.message);
    throw err;
  }
}

/**
 * 创建人脸聚类表
 */
function createTableFaceClusters() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS face_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        cluster_id INTEGER NOT NULL,
        face_embedding_id INTEGER NOT NULL,
        similarity_score REAL,
        is_representative BOOLEAN DEFAULT FALSE,
        is_user_assigned BOOLEAN DEFAULT FALSE,
        name TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (face_embedding_id) REFERENCES face_embeddings(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, cluster_id, face_embedding_id)
      );
    `;
    db.prepare(sql).run();
    console.log("✅ 创建人脸聚类表");

    // 创建索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_clusters_user_id
      ON face_clusters(user_id);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_id
      ON face_clusters(cluster_id);
    `,
    ).run();

    // 创建复合索引优化按人物查询照片的性能
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_clusters_cluster_user
      ON face_clusters(cluster_id, user_id);
    `,
    ).run();

    // 创建复合索引优化 JOIN 查询性能（用于 images JOIN face_embeddings JOIN face_clusters）
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_clusters_embedding_cluster
      ON face_clusters(face_embedding_id, cluster_id);
    `,
    ).run();

    // 创建复合索引优化封面查询性能
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_clusters_user_cluster_rep
      ON face_clusters(user_id, cluster_id, is_representative DESC, similarity_score DESC);
    `,
    ).run();

    // 创建索引优化 face_embeddings 的 ignored_for_clustering 查询
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_ignored
      ON face_embeddings(ignored_for_clustering);
    `,
    ).run();

    // 创建复合索引优化 JOIN 查询
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_face_embeddings_image_ignored
      ON face_embeddings(image_id, ignored_for_clustering);
    `,
    ).run();

    console.log("✅ 创建人脸聚类表索引");
  } catch (err) {
    console.error("创建人脸聚类表失败：", err.message);
    throw err;
  }
}

/**
 * 创建 cleanup_groups 表
 */
function createTableCleanupGroups() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS cleanup_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        group_type TEXT NOT NULL,
        primary_image_id INTEGER,
        member_count INTEGER DEFAULT 0,
        total_size_bytes INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (primary_image_id) REFERENCES images(id) ON DELETE SET NULL
      );
    `;
    db.prepare(sql).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_cleanup_groups_user_type
      ON cleanup_groups(user_id, group_type);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_cleanup_groups_user_updated
      ON cleanup_groups(user_id, updated_at DESC);
    `,
    ).run();

    console.log("✅ 创建 cleanup_groups 表及索引");
  } catch (err) {
    console.error("创建 cleanup_groups 表失败：", err.message);
    throw err;
  }
}

/**
 * 创建 cleanup_group_members 表
 */
function createTableCleanupGroupMembers() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS cleanup_group_members (
        group_id INTEGER NOT NULL,
        image_id INTEGER NOT NULL,
        rank_score REAL,
        similarity REAL,
        aesthetic_score REAL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        PRIMARY KEY (group_id, image_id),
        FOREIGN KEY (group_id) REFERENCES cleanup_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
      );
    `;
    db.prepare(sql).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_cleanup_members_group_rank
      ON cleanup_group_members(group_id, rank_score DESC);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_cleanup_members_image
      ON cleanup_group_members(image_id);
    `,
    ).run();

    console.log("✅ 创建 cleanup_group_members 表及索引");
  } catch (err) {
    console.error("创建 cleanup_group_members 表失败：", err.message);
    throw err;
  }
}

/**
 * 创建相册表
 */
function createTableAlbums() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        cover_image_id INTEGER,
        album_type TEXT DEFAULT 'custom',
        image_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        deleted_at INTEGER,
        
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (cover_image_id) REFERENCES images(id) ON DELETE SET NULL
      );
    `;
    db.prepare(sql).run();

    // 创建索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_albums_user_id ON albums(user_id);
    `,
    ).run();

    // 创建部分唯一索引（实现软删除后的唯一性约束）
    db.prepare(
      `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_user_name_unique ON albums(user_id, name) WHERE deleted_at IS NULL;
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_albums_user_type ON albums(user_id, album_type);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_albums_user_created ON albums(user_id, created_at DESC);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_albums_user_deleted ON albums(user_id, deleted_at) WHERE deleted_at IS NULL;
    `,
    ).run();

    console.log("✅ 创建 albums 表及索引");
  } catch (err) {
    console.error("创建 albums 表失败：", err.message);
    throw err;
  }
}

/**
 * 创建相册-图片关联表
 */
function createTableAlbumImages() {
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS album_images (
        album_id INTEGER NOT NULL,
        image_id INTEGER NOT NULL,
        added_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        
        PRIMARY KEY (album_id, image_id),
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
      );
    `;
    db.prepare(sql).run();

    // 创建索引
    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_album_images_album_id ON album_images(album_id, added_at DESC);
    `,
    ).run();

    db.prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_album_images_image_id ON album_images(image_id);
    `,
    ).run();

    console.log("✅ 创建 album_images 表及索引");
  } catch (err) {
    console.error("创建 album_images 表失败：", err.message);
    throw err;
  }
}

module.exports = {
  deleteTableUsers,
  createTableUsers,
  deleteTableImages,
  createTableImages,
  createTableImageEmbeddings,
  createTableFaceEmbeddings,
  createTableFaceClusters,
  createTableCleanupGroups,
  createTableCleanupGroupMembers,
  createTableAlbums,
  createTableAlbumImages,
};
