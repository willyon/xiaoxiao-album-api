/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 22:24:29
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-09 10:30:00
 * @Description: 数据清理脚本 - 支持选择性清理存储文件、队列和Redis键
 * @Usage: node scripts/development/clear-image-data.js [选项]
 *
 * 功能说明：
 *   1. 清理存储文件：清空数据库表、删除本地存储文件和OSS存储文件
 *   2. 清理队列：清空BullMQ队列中的所有任务
 *   3. 清理Redis键：删除Redis中的相关键值
 *
 * 安全特性：
 *   - 默认不执行任何清理操作
 *   - 需要明确指定参数才会执行相应操作
 *   - 支持组合使用多个参数
 */
const path = require("path");

// 获取脚本所在目录的绝对路径
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const fs = require("fs");

// 解析命令行参数
const args = process.argv.slice(2);
const CLEAR_STORAGE = args.includes("--clear-storage");
const CLEAR_QUEUES = args.includes("--clear-queues");
const CLEAR_REDIS = args.includes("--clear-redis");
const CLEAR_ALL = args.includes("--clear-all");

// 如果没有指定任何参数，显示帮助信息
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log("使用方法：");
  console.log("  node scripts/development/clear-image-data.js [选项]");
  console.log("");
  console.log("选项：");
  console.log("  --clear-storage  清理存储文件（数据库表、本地文件、OSS文件）");
  console.log("  --clear-queues   清理BullMQ队列");
  console.log("  --clear-redis    清理Redis键（包括用户集合、会话进度等）");
  console.log("  --clear-all      清理所有数据（等同于上述三个选项）");
  console.log("  -h, --help       显示帮助信息");
  console.log("");
  console.log("示例：");
  console.log("  node scripts/development/clear-image-data.js --clear-all");
  console.log("  node scripts/development/clear-image-data.js --clear-storage --clear-queues");
  process.exit(0);
}

// 使用绝对路径导入模块
const { db } = require(path.join(projectRoot, "src", "services", "database"));
// 注意：不再导入队列模块，避免初始化 IORedis 连接时尝试连接 ECS 元数据服务
// 队列清理将直接通过 Redis 客户端操作

// ============清空数据库相关表所有数据==========//
function clearImagesTable() {
  db.prepare("DELETE FROM images").run();
  console.log("images数据表已清空");
}

function clearFaceEmbeddingsTable() {
  db.prepare("DELETE FROM face_embeddings").run();
  console.log("face_embeddings数据表已清空");
}

function clearFaceClustersTable() {
  db.prepare("DELETE FROM face_clusters").run();
  console.log("face_clusters数据表已清空");
}

function clearImageEmbeddingsTable() {
  db.prepare("DELETE FROM image_embeddings").run();
  console.log("image_embeddings数据表已清空");
}

function clearSimilarGroupsTables() {
  db.prepare("DELETE FROM similar_group_members").run();
  console.log("similar_group_members数据表已清空");
  db.prepare("DELETE FROM similar_groups").run();
  console.log("similar_groups数据表已清空");
}
// ============清空数据库相关表所有数据==========//

// ============清空图片转换过程中涉及的所有目标文件夹的所有图片==========//
function deleteFolderSync(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((file) => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderSync(curPath); // 递归删除子文件夹
      } else {
        fs.unlinkSync(curPath); // 删除文件
      }
    });
    console.log("各文件夹图片已清空:", folderPath);
    // fs.rmdirSync(folderPath); // 删除空文件夹
  }
}

// 清空本地磁盘存储的图片文件
function clearLocalStorageFiles() {
  console.log("🗂️  开始清空本地磁盘存储文件...");
  const clearFolders = {
    uploadFolder: path.join(__dirname, "..", process.env.UPLOADS_DIR), //上传成功待处理图片存放文件夹
    failedFolder: path.join(__dirname, "..", process.env.FAILED_IMAGE_DIR), //处理失败图片存放文件夹
    originalFolder: path.join(__dirname, "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR), //上传原图存放文件夹
    highResFolder: path.join(__dirname, "..", process.env.PROCESSED_HIGH_RES_IMAGE_DIR),
    thumbnailFolder: path.join(__dirname, "..", process.env.PROCESSED_THUMBNAIL_IMAGE_DIR),
  };

  for (let key in clearFolders) {
    deleteFolderSync(clearFolders[key]);
  }
  console.log("✅ 本地磁盘存储文件清空完成");
}

// 清空OSS存储的图片文件
async function clearOSSStorageFiles() {
  console.log("☁️  跳过OSS存储文件清理...");
  console.log("⚠️  为了保护OSS中的图片数据，已禁用OSS文件删除功能");
  console.log("💡 如需删除OSS文件，请手动在阿里云控制台操作");
  return; // 直接返回，不执行任何删除操作
}

// 清空所有存储类型的文件（本地存储 + OSS存储）
async function clearStorageFiles() {
  console.log("🗂️  开始清空所有存储类型的文件...");

  // 1. 清空数据库表数据（顺序：先子表后主表，避免外键约束）
  console.log("\n📊 第一步：清空数据库表数据");
  clearImagesTable();
  clearFaceEmbeddingsTable();
  clearFaceClustersTable();
  clearImageEmbeddingsTable();
  clearSimilarGroupsTables();

  // 2. 清空本地存储文件
  console.log("\n📁 第二步：清空本地存储文件");
  clearLocalStorageFiles();

  // 3. 清空OSS存储文件
  console.log("\n☁️  第三步：清空OSS存储文件");
  try {
    await clearOSSStorageFiles();
  } catch (error) {
    console.warn("⚠️  OSS存储清空失败，可能是配置问题，继续执行其他清理操作");
    console.warn(`   错误详情: ${error.message}`);
  }

  console.log("\n✅ 所有存储类型的文件清空完成");
  console.log("🎉 所有操作已完成！系统已准备就绪！");
}

// 存储文件清理将在main()函数中执行
// ============清空图片转换过程中涉及的所有目标文件夹的所有图片==========//

// ============清空 BullMQ 队列中所有任务（等待、活跃、失败、完成、延迟）==========//
// 🟢 优化：直接通过 Redis 客户端清理队列，避免初始化 BullMQ 队列对象时连接 ECS 元数据服务
async function clearAllQueueJobs() {
  try {
    console.log("📋 开始清空 BullMQ 队列...");

    // 使用已在文件顶部导入的 Redis 客户端（redisClient）

    // BullMQ 队列键格式：bull:{queueName}:*
    // 需要清理的队列名称（从环境变量获取，如果没有则使用默认值）
    const queueNames = [
      process.env.IMAGE_UPLOAD_QUEUE_NAME || "imageUploadQueue",
      process.env.IMAGE_META_QUEUE_NAME || "imageMetaQueue",
      process.env.SEARCH_INDEX_QUEUE_NAME || "searchIndexQueue",
      process.env.CLEANUP_QUEUE_NAME || "cleanupQueue",
    ];

    let totalDeletedKeys = 0;

    for (const queueName of queueNames) {
      console.log(`清空队列: ${queueName}...`);
      const queuePattern = `bull:${queueName}:*`;
      let cursor = "0";
      let queueDeletedKeys = 0;

      do {
        const [newCursor, keys] = await redisClient.scan(cursor, "MATCH", queuePattern, "COUNT", 100);
        cursor = newCursor;
        if (keys.length > 0) {
          await redisClient.del(...keys);
          queueDeletedKeys += keys.length;
          totalDeletedKeys += keys.length;
        }
      } while (cursor !== "0");

      if (queueDeletedKeys > 0) {
        console.log(`  ✅ ${queueName} 队列清理完成，删除了 ${queueDeletedKeys} 个键`);
      } else {
        console.log(`  ℹ️  ${queueName} 队列为空，无需清理`);
      }
    }

    console.log(`✅ BullMQ 队列所有任务已清空，总共删除了 ${totalDeletedKeys} 个键`);
  } catch (err) {
    console.error("❌ 清空 BullMQ 队列任务失败：", err);
    throw err;
  }
}
// ============清空 BullMQ 队列中所有任务（等待、活跃、失败、完成、延迟）==========//

// ============清空 Redis 中 readyKeyOf、lockKeyOf、userSetKey 和进度 session 相关键，用于开发测试环境快速重置==========//
const { readyKeyOf, lockKeyOf, userSetKey } = require("../../src/workers/userImageHashset");
const { getRedisClient } = require("../../src/services/redisClient");
const redisClient = getRedisClient();

async function clearRedisKeys() {
  console.log("🔑 开始清理Redis键...");

  // 原有的三类键：readyKeyOf、lockKeyOf、userSetKey
  const originalPatterns = [readyKeyOf("*"), lockKeyOf("*"), userSetKey("*")];

  // 进度 session 与其它业务键
  const sessionPatterns = [
    "upload:session:*", // 上传会话进度数据
    "user:latest:session:*", // 用户最新会话ID
    "session:*:progress", // 进度推送频道
  ];
  const lockAndCooldownPatterns = [
    `${process.env.IMAGES_HASH_LOCK_KEY_PREFIX || "lock:image:hash:"}*`, // 图片哈希分布式锁
    "*_cooldown_*", // 冷却键（如邮件验证码）
  ];

  const allPatterns = [...originalPatterns, ...sessionPatterns, ...lockAndCooldownPatterns];

  let totalDeletedKeys = 0;

  for (const pattern of allPatterns) {
    console.log(`🔍 扫描模式: ${pattern}`);
    let cursor = "0";
    let patternDeletedKeys = 0;

    do {
      const [newCursor, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = newCursor;
      if (keys.length > 0) {
        await redisClient.del(...keys);
        patternDeletedKeys += keys.length;
        totalDeletedKeys += keys.length;
      }
    } while (cursor !== "0");

    if (patternDeletedKeys > 0) {
      console.log(`  ✅ 删除 ${patternDeletedKeys} 个键`);
    } else {
      console.log(`  ℹ️  未找到匹配的键`);
    }
  }

  console.log(`🎉 Redis清理完成！总共删除了 ${totalDeletedKeys} 个键`);
  console.log("📋 清理的键类型包括：");
  console.log("  - images:hashset:ready:* / lock:images:hashset:init:* / images:hashset:user:*");
  console.log("  - upload:session:* / user:latest:session:* / session:*:progress");
  console.log("  - lock:image:hash:*（图片哈希锁） / *_cooldown_*（冷却键）");
}

// 主函数：根据参数协调清理操作
async function main() {
  try {
    console.log("🚀 开始执行清理操作...");
    console.log(`📋 清理选项：存储文件=${CLEAR_STORAGE || CLEAR_ALL}, 队列=${CLEAR_QUEUES || CLEAR_ALL}, Redis=${CLEAR_REDIS || CLEAR_ALL}`);

    let hasOperations = false;

    // 1. 清理存储文件
    if (CLEAR_STORAGE || CLEAR_ALL) {
      console.log("📁 开始清理存储文件...");
      await clearStorageFiles();
      hasOperations = true;
    } else {
      console.log("⏭️ 跳过存储文件清理");
    }

    // 2. 清理队列
    if (CLEAR_QUEUES || CLEAR_ALL) {
      console.log("📋 开始清理队列...");
      await clearAllQueueJobs();
      hasOperations = true;
    } else {
      console.log("⏭️ 跳过队列清理");
    }

    // 3. 清理Redis键
    if (CLEAR_REDIS || CLEAR_ALL) {
      console.log("🔑 开始清理Redis键...");
      await clearRedisKeys();
      hasOperations = true;
    } else {
      console.log("⏭️ 跳过Redis键清理");
    }

    if (hasOperations) {
      console.log("🎉 清理操作完成！");
    } else {
      console.log("ℹ️ 没有指定清理操作，请使用 --help 查看可用选项");
    }
    process.exit(0);
  } catch (error) {
    console.error("❌ 清理操作失败:", error);
    process.exit(1);
  }
}

// 执行主函数
main();
// ============清空 Redis 中 readyKeyOf、lockKeyOf、userSetKey 三类键，用于开发测试环境快速重置==========//
