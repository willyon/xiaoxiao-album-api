/*
 * @Author: zhangshouchang
 * @Date: 2025-01-07
 * @Description: 数据库重建脚本 - 删除旧表并重新创建标准化的表结构
 * @Usage: node deployment-scripts/rebuild-database.js
 */

// 获取脚本所在目录的绝对路径
const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "dbService"));
const { createTableUsers, createTableImages, createTableUploadSessions } = require(path.join(projectRoot, "src", "models", "initTableModel"));

async function rebuildDatabase() {
  try {
    console.log("🚀 开始重建数据库...");
    console.log("⚠️  警告：此操作将删除所有现有数据！");

    // 检查表是否存在
    const usersTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    const imagesTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'").get();
    const uploadSessionsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_sessions'").get();

    if (!usersTableExists && !imagesTableExists && !uploadSessionsTableExists) {
      console.log("ℹ️  数据库表不存在，直接创建新表...");
    } else {
      console.log("📊 发现现有表，准备删除并重建...");
    }

    // 开始事务
    db.prepare("BEGIN TRANSACTION").run();

    try {
      // 1. 删除现有表（如果存在）
      console.log("🗑️  删除现有表...");

      if (imagesTableExists) {
        db.prepare("DROP TABLE IF EXISTS images").run();
        console.log("✅ 删除 images 表");
      }

      if (uploadSessionsTableExists) {
        db.prepare("DROP TABLE IF EXISTS upload_sessions").run();
        console.log("✅ 删除 upload_sessions 表");
      }

      if (usersTableExists) {
        db.prepare("DROP TABLE IF EXISTS users").run();
        console.log("✅ 删除 users 表");
      }

      // 2. 重新创建表（使用新的标准化字段名）
      console.log("📝 创建新的标准化表结构...");

      // 创建 users 表
      createTableUsers();
      console.log("✅ 创建 users 表（字段：verified_status, verification_token, created_at）");

      // 创建 images 表
      createTableImages();
      console.log(
        "✅ 创建 images 表（字段：original_storage_key, high_res_storage_key, thumbnail_storage_key, image_created_at, session_id, processing_state, created_at, year_key, month_key, gps_latitude, gps_longitude, gps_altitude, gps_location, storage_type, file_size）",
      );

      // 创建 upload_sessions 表
      createTableUploadSessions();
      console.log(
        "✅ 创建 upload_sessions 表（字段：id, user_id, total_files, uploaded_originals, thumb_done, high_res_done, errors, status, created_at, updated_at）",
      );

      // 提交事务
      db.prepare("COMMIT").run();

      console.log("🎉 数据库重建完成！");
      console.log("📋 重建总结：");
      console.log("   - 删除了所有旧表和数据");
      console.log("   - 创建了标准化的表结构（下划线字段名）");
      console.log("   - 所有索引已自动创建");
      console.log("   - 现在可以使用新的字段映射功能");
    } catch (error) {
      // 回滚事务
      db.prepare("ROLLBACK").run();
      throw error;
    }
  } catch (error) {
    console.error("❌ 数据库重建失败:", error.message);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  rebuildDatabase().then(() => {
    process.exit(0);
  });
}

module.exports = { rebuildDatabase };
