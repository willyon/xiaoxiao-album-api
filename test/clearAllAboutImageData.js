/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 22:24:29
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-17 15:45:44
 * @Description: File description
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { db } = require("../src/services/dbService");
const { imageUploadQueue } = require("../src/queues/imageUploadQueue");
const { imageMetaQueue } = require("../src/queues/imageMetaQueue");

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
// ============清空图片转换过程中涉及的所有目标文件夹的所有图片==========//

// ============清空 BullMQ 队列中未处理的任务==========//
async function clearPendingJobs() {
  try {
    await imageUploadQueue.drain(true); // true 表示移除延迟任务
    await imageMetaQueue.drain(true);
    console.log("BullMQ 队列等待中和延迟的任务已清空");
  } catch (err) {
    console.error("清空 BullMQ 队列任务失败：", err);
  }
}
clearPendingJobs().catch(console.error);
// ============清空 BullMQ 队列中未处理的任务==========//

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
