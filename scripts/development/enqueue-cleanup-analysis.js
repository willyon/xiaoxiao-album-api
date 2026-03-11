/*
 * @Author: 自动化脚本
 * @Description: 批量将需要清理分析的图片加入 cleanupQueue
 *
 * 🎯 功能：
 * • 扫描还未生成清理指标的图片
 * • 将这些图片逐一加入 cleanupQueue，触发后续 Python 清理分析
 *
 * 📋 判断标准：
 * • 已完成高清图处理（high_res_storage_key 或 original_storage_key 不为 NULL）
 * • 且任一清理指标为空：perceptual_hash / aesthetic_score / sharpness_score / similarity_cluster_id / duplicate_group_id
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

process.chdir(projectRoot);

require("dotenv").config();
const { findImagesNeedingCleanup, retryFailedCleanupJobs, enqueueCleanupJobs } = require(
  path.join(projectRoot, "src", "services", "cleanupEnqueueHelper"),
);
const { cleanupQueue, closeCleanupQueue } = require(path.join(projectRoot, "src", "queues", "cleanupQueue"));
const logger = require(path.join(projectRoot, "src", "utils", "logger"));

function verifyConfiguration() {
  console.log("\n🔧 步骤0: 验证配置...");

  const queueName = process.env.CLEANUP_QUEUE_NAME;
  console.log(`   Cleanup Queue 名称                    : ${queueName || "❌ 未配置"}`);

  if (!queueName) {
    console.log("\n   ❌ 错误: CLEANUP_QUEUE_NAME 未配置，脚本终止");
    return false;
  }

  console.log("   ✅ 配置验证通过");
  return true;
}

function describeRecords(records) {
  console.log("\n🔍 步骤1: 查询需要清理分析的图片...");

  console.log(`   ✅ 找到 ${records.length} 张需要清理分析的图片`);

  if (records.length > 0) {
    console.log("   📋 前10条记录示例:");
    records.slice(0, 10).forEach((record, index) => {
      const createdAt = record.created_at ? new Date(record.created_at).toISOString() : "未知";
      console.log(`      ${index + 1}. ImageID=${record.id}, UserID=${record.user_id}, CreatedAt=${createdAt}`);
    });
    if (records.length > 10) {
      console.log(`      ... 还有 ${records.length - 10} 条记录待处理`);
    }
  }

  return records;
}

async function enqueueForCleanup(records) {
  console.log("\n📤 步骤3: 将图片加入 cleanup 队列...");
  const result = await enqueueCleanupJobs(records);

  if (result.successCount > 0) {
    console.log(`   ✅ 成功加入 ${result.successCount} 张图片`);
  }
  if (result.skippedCount > 0) {
    console.log(`   ⏭️  跳过 ${result.skippedCount} 张（已在队列中或正在处理）`);
  }
  if (result.failCount > 0) {
    console.log(`   ❌ 加入失败 ${result.failCount} 张图片`);
  }

  return result;
}

async function checkQueueStatus() {
  console.log("\n📊 步骤4: 检查 cleanup 队列状态...");
  try {
    const counts = await cleanupQueue.getJobCounts();
    console.log("   📋 队列统计：");
    console.log(`      等待处理: ${counts.waiting}`);
    console.log(`      正在处理: ${counts.active}`);
    console.log(`      已完成  : ${counts.completed}`);
    console.log(`      失败    : ${counts.failed}`);
    console.log(`      延迟    : ${counts.delayed}`);
    return counts;
  } catch (error) {
    console.log(`   ⚠️  无法获取队列状态: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         🧹 批量清理分析队列加入脚本                           ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  try {
    const configOk = verifyConfiguration();
    if (!configOk) {
      process.exit(1);
    }

    // 支持从命令行参数获取 userId，默认为 1
    const userId = Number(process.argv[2]) || 1;
    console.log(`\n👤 处理用户ID: ${userId}\n`);

    const records = findImagesNeedingCleanup({ userId });
    describeRecords(records);
    if (records.length === 0) {
      console.log("\n✅ 已无缺少清理指标的图片，无需处理");
      return;
    }

    const failedJobsResult = await retryFailedCleanupJobs();
    const enqueueResult = await enqueueForCleanup(records);
    await checkQueueStatus();

    console.log("\n╔═══════════════════════════════════════════════════════════════╗");
    console.log("║         📊 加入 cleanup 队列统计                               ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝\n");
    console.log(`📋 候选图片总数:          ${records.length}`);
    if (failedJobsResult.hadFailed) {
      console.log(`🔄 重试失败任务:          ${failedJobsResult.retriedCount}`);
    }
    console.log(`✅ 成功加入队列:          ${enqueueResult.successCount}`);
    if (enqueueResult.skippedCount > 0) {
      console.log(`⏭️  跳过（已在队列中）:    ${enqueueResult.skippedCount}`);
    }
    console.log(`❌ 加入队列失败:          ${enqueueResult.failCount}`);
    console.log("");

    if (enqueueResult.errors.length > 0) {
      console.log("⚠️  失败详情（前5条）:");
      enqueueResult.errors.slice(0, 5).forEach((err) => {
        console.log(`   - ImageID=${err.imageId}, UserID=${err.userId}, Error=${err.error}`);
      });
      if (enqueueResult.errors.length > 5) {
        console.log(`   ... 还有 ${enqueueResult.errors.length - 5} 条错误`);
      }
      console.log("");
    }

    if (enqueueResult.successCount > 0) {
      console.log("✅ 清理分析任务已全部加入队列");
      console.log("💡 请确保 cleanupWorker 与 Python 清理服务正在运行");
    }
  } catch (error) {
    console.error("\n❌ 脚本执行出错:", error);
    console.error("Stack:", error.stack);
    throw error;
  } finally {
    try {
      await closeCleanupQueue();
    } catch (closeError) {
      logger.warn({
        message: "关闭 cleanupQueue 连接失败",
        details: { error: closeError.message },
      });
    }
  }
}

main()
  .then(() => {
    console.log("\n✅ 脚本执行完成");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 脚本执行失败:", error.message);
    process.exit(1);
  });
