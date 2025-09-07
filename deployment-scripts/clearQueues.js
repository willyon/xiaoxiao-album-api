/*
 * @Author: zhangshouchang
 * @Date: 2025-01-06
 * @Description: 专门用于清理 BullMQ 队列的脚本
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { imageUploadQueue } = require("../src/queues/imageUploadQueue");
const { imageMetaQueue } = require("../src/queues/imageMetaQueue");

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

    console.log("🎉 BullMQ 队列所有任务已清空");
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
