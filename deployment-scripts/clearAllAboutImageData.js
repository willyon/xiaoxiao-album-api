/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 22:24:29
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-01-09 10:30:00
 * @Description: 数据清理脚本 - 支持选择性清理存储文件、队列和Redis键
 * @Usage: node clearAllAboutImageData.js [选项]
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
const projectRoot = path.resolve(scriptDir, "..");

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
  console.log("  node clearAllAboutImageData.js [选项]");
  console.log("");
  console.log("选项：");
  console.log("  --clear-storage  清理存储文件（数据库表、本地文件、OSS文件）");
  console.log("  --clear-queues   清理BullMQ队列");
  console.log("  --clear-redis    清理Redis键");
  console.log("  --clear-all      清理所有数据（等同于上述三个选项）");
  console.log("  -h, --help       显示帮助信息");
  console.log("");
  console.log("示例：");
  console.log("  node clearAllAboutImageData.js --clear-all");
  console.log("  node clearAllAboutImageData.js --clear-storage --clear-queues");
  process.exit(0);
}

// 使用绝对路径导入模块
const { db } = require(path.join(projectRoot, "src", "services", "dbService"));
// 队列导入
const { imageUploadQueue } = require(path.join(projectRoot, "src", "queues", "imageUploadQueue"));
const { imageMetaQueue } = require(path.join(projectRoot, "src", "queues", "imageMetaQueue"));
const StorageAdapterFactory = require(path.join(projectRoot, "src", "storage", "factory", "StorageAdapterFactory"));
const { STORAGE_TYPES } = require(path.join(projectRoot, "src", "storage", "constants", "StorageTypes"));

// ============清空数据库 images 表所有数据==========//
function clearImagesTable() {
  db.prepare("DELETE FROM images").run();
  console.log("images数据表已清空");
}
// ============清空数据库 images 表所有数据==========//

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
  console.log("☁️  开始清空OSS存储文件...");

  try {
    // 调试信息：检查环境变量
    console.log("🔍 调试信息：");
    console.log(`  ALIYUN_OSS_AUTH_TYPE: ${process.env.ALIYUN_OSS_AUTH_TYPE || "undefined"}`);
    console.log(`  ALIYUN_OSS_REGION: ${process.env.ALIYUN_OSS_REGION || "undefined"}`);
    console.log(`  ALIYUN_OSS_BUCKET: ${process.env.ALIYUN_OSS_BUCKET || "undefined"}`);

    // 尝试创建OSS适配器
    const storageAdapter = StorageAdapterFactory.createAdapter(STORAGE_TYPES.ALIYUN_OSS, false);

    // 检查适配器类型
    if (storageAdapter.type !== STORAGE_TYPES.ALIYUN_OSS) {
      console.warn("⚠️  无法创建OSS适配器，跳过OSS存储清理");
      return;
    }

    // 定义需要清空的前缀
    const prefixes = [
      "upload/", // 上传文件
      "failed/", // 失败文件
      "original/", // 原图
      "highres/", // 高清图
      "thumbnail/", // 缩略图
    ];

    let totalDeleted = 0;

    for (const prefix of prefixes) {
      console.log(`  正在清空前缀: ${prefix}`);

      try {
        // 获取该前缀下的所有文件
        const files = await storageAdapter.listFiles(prefix);

        if (files.length) {
          console.log(`  找到 ${files.length} 个文件，开始删除...`);

          // 批量删除文件
          const results = await storageAdapter.deleteFiles(files);

          // 统计删除结果
          const successCount = results.filter((r) => r.success).length;
          const failCount = results.filter((r) => !r.success).length;

          totalDeleted += successCount;
          console.log(`  前缀 ${prefix} 删除完成: 成功 ${successCount} 个，失败 ${failCount} 个`);

          if (failCount > 0) {
            console.warn(`  以下文件删除失败:`);
            results
              .filter((r) => !r.success)
              .forEach((r) => {
                console.warn(`    - ${r.key}: ${r.error}`);
              });
          }
        } else {
          console.log(`  前缀 ${prefix} 下没有文件`);
        }
      } catch (prefixError) {
        console.warn(`  前缀 ${prefix} 处理失败: ${prefixError.message}`);
        continue; // 继续处理下一个前缀
      }
    }

    console.log(`✅ OSS存储文件清空完成，共删除 ${totalDeleted} 个文件`);
  } catch (error) {
    console.warn("⚠️  OSS存储清空失败，可能是配置问题");
    console.warn(`   错误详情: ${error.message}`);
    throw error; // 重新抛出错误，让上层处理
  }
}

// 清空所有存储类型的文件（本地存储 + OSS存储）
async function clearStorageFiles() {
  console.log("🗂️  开始清空所有存储类型的文件...");

  // 1. 清空数据库表数据
  console.log("\n📊 第一步：清空数据库表数据");
  clearImagesTable();

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
async function clearAllQueueJobs() {
  try {
    console.log("📋 开始清空 BullMQ 队列...");

    // 清空上传队列
    console.log("清空图片上传队列...");
    const uploadStats = {
      waiting: await imageUploadQueue.clean(0, 1000, "waiting"),
      active: await imageUploadQueue.clean(0, 1000, "active"),
      completed: await imageUploadQueue.clean(0, 1000, "completed"),
      failed: await imageUploadQueue.clean(0, 1000, "failed"),
      delayed: await imageUploadQueue.clean(0, 1000, "delayed"),
    };
    await imageUploadQueue.drain(true); // 清空剩余的等待任务

    console.log(
      `上传队列清理完成: 等待${uploadStats.waiting} | 活跃${uploadStats.active} | 完成${uploadStats.completed} | 失败${uploadStats.failed} | 延迟${uploadStats.delayed}`,
    );

    // 清空元数据队列
    console.log("清空图片元数据队列...");
    const metaStats = {
      waiting: await imageMetaQueue.clean(0, 1000, "waiting"),
      active: await imageMetaQueue.clean(0, 1000, "active"),
      completed: await imageMetaQueue.clean(0, 1000, "completed"),
      failed: await imageMetaQueue.clean(0, 1000, "failed"),
      delayed: await imageMetaQueue.clean(0, 1000, "delayed"),
    };
    await imageMetaQueue.drain(true); // 清空剩余的等待任务

    console.log(
      `元数据队列清理完成: 等待${metaStats.waiting} | 活跃${metaStats.active} | 完成${metaStats.completed} | 失败${metaStats.failed} | 延迟${metaStats.delayed}`,
    );

    console.log("✅ BullMQ 队列所有任务已清空");
  } catch (err) {
    console.error("❌ 清空 BullMQ 队列任务失败：", err);
    throw err;
  }
}

clearAllQueueJobs().catch(console.error);
// ============清空 BullMQ 队列中所有任务（等待、活跃、失败、完成、延迟）==========//

// ============清空 Redis 中 readyKeyOf、lockKeyOf、userSetKey 三类键，用于开发测试环境快速重置==========//
const { readyKeyOf, lockKeyOf, userSetKey } = require("../src/workers/userImageHashset");
const { getRedisClient } = require("../src/services/redisClient");
const redisClient = getRedisClient();

async function clearRedisKeys() {
  const patterns = [readyKeyOf("*"), lockKeyOf("*"), userSetKey("*")];

  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [newCursor, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = newCursor;
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
    } while (cursor !== "0");
  }
  console.log("redis集合已清空");
  console.log("OK!清空工作完毕！");
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
