/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 22:24:29
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:45:44
 * @Description: File description
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const { db } = require("../src/services/dbService");
// 队列导入
const { imageUploadQueue } = require("../src/queues/imageUploadQueue");
const { imageMetaQueue } = require("../src/queues/imageMetaQueue");
const StorageAdapterFactory = require("../src/storage/factory/StorageAdapterFactory");
const { STORAGE_TYPES } = require("../src/storage/constants/StorageTypes");

// ============清空数据库 images 表所有数据==========//
function clearImagesTable() {
  db.prepare("DELETE FROM images").run();
  console.log("images数据表已清空");
}
clearImagesTable();
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

  // 1. 清空本地存储文件
  console.log("\n📁 第一步：清空本地存储文件");
  clearLocalStorageFiles();

  // 2. 清空OSS存储文件
  console.log("\n☁️  第二步：清空OSS存储文件");
  try {
    await clearOSSStorageFiles();
  } catch (error) {
    console.warn("⚠️  OSS存储清空失败，可能是配置问题，继续执行其他清理操作");
    console.warn(`   错误详情: ${error.message}`);
  }

  console.log("\n✅ 所有存储类型的文件清空完成");
}

// 执行存储文件清理
clearStorageFiles().catch(console.error);
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

clearRedisKeys().catch(console.error);
// ============清空 Redis 中 readyKeyOf、lockKeyOf、userSetKey 三类键，用于开发测试环境快速重置==========//
