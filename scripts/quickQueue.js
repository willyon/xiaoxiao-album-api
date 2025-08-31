#!/usr/bin/env node

/*
 * 快速查看队列状态 - 简化版本
 *
 * 使用: node scripts/quickQueue.js
 */

require("dotenv").config();
const { Queue } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis({ maxRetriesPerRequest: null });

async function quickCheck() {
  try {
    // 创建队列实例
    const uploadQueue = new Queue(process.env.IMAGE_UPLOAD_QUEUE_NAME || "imageUploadQueue", { connection });
    const metaQueue = new Queue(process.env.IMAGE_META_QUEUE_NAME || "imageMetaQueue", { connection });

    console.log("\n📊 队列快速状态");
    console.log("=".repeat(40));

    // 检查上传队列
    const [uploadWaiting, uploadActive, uploadFailed] = await Promise.all([
      uploadQueue.getWaiting(),
      uploadQueue.getActive(),
      uploadQueue.getFailed(),
    ]);

    console.log(`🔄 上传队列: 等待${uploadWaiting.length} | 处理中${uploadActive.length} | 失败${uploadFailed.length}`);

    // 检查元数据队列
    const [metaWaiting, metaActive, metaFailed] = await Promise.all([metaQueue.getWaiting(), metaQueue.getActive(), metaQueue.getFailed()]);

    console.log(`📝 元数据队列: 等待${metaWaiting.length} | 处理中${metaActive.length} | 失败${metaFailed.length}`);

    // 如果有活跃任务，显示详情
    if (uploadActive.length > 0) {
      console.log("\n🔄 上传队列处理中:");
      uploadActive.slice(0, 3).forEach((job, i) => {
        console.log(`  ${i + 1}. ${job.data?.filename || job.id}`);
      });
    }

    if (metaActive.length > 0) {
      console.log("\n📝 元数据队列处理中:");
      metaActive.slice(0, 3).forEach((job, i) => {
        console.log(`  ${i + 1}. ${job.data?.filename || job.id}`);
      });
    }

    // 关闭连接
    await uploadQueue.close();
    await metaQueue.close();
    await connection.quit();
  } catch (error) {
    console.error("❌ 检查失败:", error.message);
    process.exit(1);
  }
}

quickCheck();
