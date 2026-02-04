/*
 * 重试失败任务的脚本
 * 用于手动重试各 BullMQ 队列中失败的任务（upload / meta / search / cleanup）
 *
 * 用法: node scripts/development/retry-failed-jobs.js [queueName]
 * 队列: all | upload | meta | search | cleanup（默认 all）
 */

const { Queue } = require("bullmq");
const Redis = require("ioredis");

async function retryFailedJobs(queueName = "all") {
  const connection = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
  });

  const queuesToRetry = [];

  if (queueName === "all" || queueName === "upload") {
    queuesToRetry.push({
      name: "imageUploadQueue",
      queue: new Queue(process.env.IMAGE_UPLOAD_QUEUE_NAME || "imageUploadQueue", { connection }),
    });
  }
  if (queueName === "all" || queueName === "meta") {
    queuesToRetry.push({
      name: "imageMetaQueue",
      queue: new Queue(process.env.IMAGE_META_QUEUE_NAME || "imageMetaQueue", { connection }),
    });
  }
  if (queueName === "all" || queueName === "search") {
    queuesToRetry.push({
      name: "searchIndexQueue",
      queue: new Queue(process.env.SEARCH_INDEX_QUEUE_NAME || "searchIndexQueue", { connection }),
    });
  }
  if (queueName === "all" || queueName === "cleanup") {
    queuesToRetry.push({
      name: "cleanupQueue",
      queue: new Queue(process.env.CLEANUP_QUEUE_NAME || "cleanupQueue", { connection }),
    });
  }

  try {
    console.log("\n=== 开始重试失败任务 ===\n");

    for (const { name, queue } of queuesToRetry) {
      console.log(`\n📦 处理队列: ${name}`);

      const failedCount = await queue.getFailedCount();
      console.log(`   失败任务数: ${failedCount}`);

      if (failedCount === 0) {
        console.log(`   ✅ 没有失败任务`);
        continue;
      }

      const failedJobs = await queue.getFailed(0, failedCount);
      console.log(`   找到 ${failedJobs.length} 个失败任务`);

      let retriedCount = 0;
      let skippedCount = 0;

      for (const job of failedJobs) {
        try {
          const maxAttempts = job.opts.attempts || 5;
          if (job.attemptsMade >= maxAttempts) {
            console.log(`   ⏭️  跳过任务 ${job.id} (已达到最大重试次数 ${maxAttempts})`);
            skippedCount++;
            continue;
          }

          await job.retry();
          const desc = job.data?.fileName ?? job.data?.imageHash ?? job.data?.imageId ?? job.id;
          console.log(`   ✅ 重试任务 ${job.id}: ${desc}`);
          retriedCount++;
        } catch (error) {
          console.log(`   ❌ 重试任务 ${job.id} 失败: ${error.message}`);
        }
      }

      console.log(`\n   📊 重试结果: 成功 ${retriedCount} | 跳过 ${skippedCount} | 总计 ${failedJobs.length}`);
    }

    console.log("\n=== 重试完成 ===\n");
  } catch (error) {
    console.error("\n❌ 重试过程中出错：", error.message);
    console.error(error.stack);
    throw error;
  } finally {
    await connection.quit();
  }
}

const queueName = process.argv[2] || "all";
const validQueues = ["all", "upload", "meta", "search", "cleanup"];

if (!validQueues.includes(queueName)) {
  console.log("用法: node scripts/development/retry-failed-jobs.js [queueName]");
  console.log("\n队列: all | upload | meta | search | cleanup（默认 all）");
  process.exit(1);
}

retryFailedJobs(queueName)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("脚本执行失败：", error);
    process.exit(1);
  });
