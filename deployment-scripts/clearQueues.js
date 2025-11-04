/*
 * @Author: zhangshouchang
 * @Date: 2025-01-06
 * @Description: 专门用于清理 BullMQ 队列的脚本
 */

// 获取脚本所在目录的绝对路径
const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const { imageUploadQueue } = require(path.join(projectRoot, "src", "queues", "imageUploadQueue"));
const { imageMetaQueue } = require(path.join(projectRoot, "src", "queues", "imageMetaQueue"));
const { searchIndexQueue } = require(path.join(projectRoot, "src", "queues", "searchIndexQueue"));

async function clearAllQueueJobs() {
  try {
    console.log("🚀 开始清空 BullMQ 队列...");

    // 清空上传队列
    console.log("📤 清空图片上传队列...");
    const uploadStats = {
      waiting: await imageUploadQueue.clean(0, 1000, "waiting"),
      active: await imageUploadQueue.clean(0, 1000, "active"),
      completed: await imageUploadQueue.clean(0, 1000, "completed"),
      failed: await imageUploadQueue.clean(0, 1000, "failed"),
      delayed: await imageUploadQueue.clean(0, 1000, "delayed"),
    };
    await imageUploadQueue.drain(true); // 清空剩余的等待任务

    console.log(
      `✅ 上传队列清理完成: 等待${uploadStats.waiting} | 活跃${uploadStats.active} | 完成${uploadStats.completed} | 失败${uploadStats.failed} | 延迟${uploadStats.delayed}`,
    );

    // 清空元数据队列
    console.log("📊 清空图片元数据队列...");
    const metaStats = {
      waiting: await imageMetaQueue.clean(0, 1000, "waiting"),
      active: await imageMetaQueue.clean(0, 1000, "active"),
      completed: await imageMetaQueue.clean(0, 1000, "completed"),
      failed: await imageMetaQueue.clean(0, 1000, "failed"),
      delayed: await imageMetaQueue.clean(0, 1000, "delayed"),
    };
    await imageMetaQueue.drain(true); // 清空剩余的等待任务

    console.log(
      `✅ 元数据队列清理完成: 等待${metaStats.waiting} | 活跃${metaStats.active} | 完成${metaStats.completed} | 失败${metaStats.failed} | 延迟${metaStats.delayed}`,
    );

    // 清空人脸识别队列
    console.log("👤 清空人脸识别队列...");
    const searchStats = {
      waiting: await searchIndexQueue.clean(0, 1000, "waiting"),
      active: await searchIndexQueue.clean(0, 1000, "active"),
      completed: await searchIndexQueue.clean(0, 1000, "completed"),
      failed: await searchIndexQueue.clean(0, 1000, "failed"),
      delayed: await searchIndexQueue.clean(0, 1000, "delayed"),
    };
    await searchIndexQueue.drain(true); // 清空剩余的等待任务

    console.log(
      `✅ 人脸识别队列清理完成: 等待${searchStats.waiting} | 活跃${searchStats.active} | 完成${searchStats.completed} | 失败${searchStats.failed} | 延迟${searchStats.delayed}`,
    );

    console.log("🎉 BullMQ 所有队列任务已清空");
  } catch (err) {
    console.error("❌ 清空 BullMQ 队列任务失败：", err);
    throw err;
  }
}

// 执行队列清理
clearAllQueueJobs()
  .then(() => {
    console.log("✅ 队列清理脚本执行完成");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 队列清理脚本执行失败：", error);
    process.exit(1);
  });
