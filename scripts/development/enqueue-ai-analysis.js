/*
 * @Author: zhangshouchang
 * @Date: 2025-11-02
 * @Description: 批量将未进行AI分析的媒体加入队列
 *
 * 🎯 功能：
 * • 查询所有有高清图/原图且未完成AI分析的媒体
 * • 将这些媒体批量加入searchIndexQueue队列
 * • 触发Python AI服务进行人脸识别分析
 *
 * 📋 判断标准：
 * • 有 high_res_storage_key 或 original_storage_key（媒体处理完成）
 * • media_analysis.analysis_status != 'done'
 *
 * 使用场景：
 * • 批量补充AI分析数据
 * • AI服务修复后重新分析
 * • 新增AI功能后补充历史数据
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { searchIndexQueue } = require(path.join(projectRoot, "src", "queues", "searchIndexQueue"));
const logger = require(path.join(projectRoot, "src", "utils", "logger"));

/**
 * 查询所有可以进行AI分析的图片记录（不管是否已分析过）
 * @returns {Array} 图片记录数组
 */
function findImagesNeedingAI() {
  console.log("🔍 步骤1: 查询需要进行AI分析的媒体...");

  const sql = `
    SELECT 
      m.id AS media_id,
      m.user_id,
      m.high_res_storage_key,
      m.original_storage_key,
      m.thumbnail_storage_key,
      m.storage_type,
      m.created_at,
      m.captured_at
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE (
        m.high_res_storage_key IS NOT NULL 
        OR m.original_storage_key IS NOT NULL
      )
      AND COALESCE(ma.analysis_status, 'pending') != 'done'
      AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
  `;

  const stmt = db.prepare(sql);
  const records = stmt.all();

  console.log(`   ✅ 找到 ${records.length} 条需要重新AI分析的媒体`);

  if (records.length > 0) {
    console.log(`   📋 记录详情（前10条）:`);
    records.slice(0, 10).forEach((record, index) => {
      const date = new Date(record.created_at).toISOString();
      console.log(`      ${index + 1}. ID=${record.media_id}, UserID=${record.user_id}, Date=${date}`);
      console.log(`         高清图: ${record.high_res_storage_key ? "✅" : "❌"}`);
      console.log(`         原图: ${record.original_storage_key ? "✅" : "❌"}`);
    });
    if (records.length > 10) {
      console.log(`      ... 还有 ${records.length - 10} 条记录`);
    }
  }

  return records;
}

/**
 * 检查并处理失败的任务
 * @returns {Object} 失败任务统计
 */
async function handleFailedJobs() {
  console.log("\n🔍 步骤2: 检查失败的任务...");

  try {
    const failedJobs = await searchIndexQueue.getFailed(0, 1000);

    if (failedJobs.length === 0) {
      console.log("   ✅ 没有失败的任务");
      return { hadFailed: false, retriedCount: 0 };
    }

    console.log(`   ⚠️  发现 ${failedJobs.length} 个失败任务`);
    console.log(`   💡 这些失败任务会阻止相同 imageId 的任务加入队列`);
    console.log(`   🔄 正在重试失败任务...\n`);

    let retriedCount = 0;
    for (const job of failedJobs) {
      try {
        await job.retry();
        retriedCount++;
        if (retriedCount <= 5) {
          console.log(`      ✅ [${retriedCount}] 重试任务: ${job.id}`);
        } else if (retriedCount % 50 === 0) {
          console.log(`      📊 进度: 已重试 ${retriedCount}/${failedJobs.length} 个任务...`);
        }
      } catch (error) {
        console.log(`      ❌ 重试失败: ${job.id} - ${error.message}`);
      }
    }

    console.log(`\n   ✅ 已重试 ${retriedCount} 个失败任务`);

    return { hadFailed: true, retriedCount };
  } catch (error) {
    console.log(`   ⚠️  处理失败任务时出错: ${error.message}`);
    return { hadFailed: false, retriedCount: 0 };
  }
}

/**
 * 批量将图片加入AI分析队列
 * @param {Array} records - 图片记录数组
 * @returns {Object} 加入队列的统计结果
 */
async function enqueueForAIAnalysis(records) {
  console.log("\n📤 步骤3: 将图片加入AI分析队列...");

  let successCount = 0;
  let skippedCount = 0;
  let failCount = 0;
  const errors = [];

  for (const record of records) {
    try {
      const jobId = `${record.user_id}:${record.media_id}`;

      // 尝试添加任务
      const job = await searchIndexQueue.add(
        process.env.SEARCH_INDEX_QUEUE_NAME,
        {
          imageId: record.media_id,
          userId: record.user_id,
          highResStorageKey: record.high_res_storage_key,
          originalStorageKey: record.original_storage_key,
        },
        {
          jobId: jobId, // 使用 imageId 作为去重标识
        },
      );

      if (job) {
        successCount++;
        // 显示前10条成功记录
        if (successCount <= 10) {
          console.log(`   ✅ [${successCount}] 加入队列: MediaID=${record.media_id}, UserID=${record.user_id}`);
        } else if (successCount % 50 === 0) {
          // 每50条显示一次进度
          console.log(`   📊 进度: 已加入 ${successCount}/${records.length} 张图片...`);
        }
      } else {
        // job 为 null 表示任务已存在（可能在队列中）
        skippedCount++;
      }
    } catch (error) {
      failCount++;
      errors.push({
        imageId: record.media_id,
        userId: record.user_id,
        error: error.message,
      });

      // 显示前3条失败记录
      if (failCount <= 3) {
        console.log(`   ❌ 加入队列失败: MediaID=${record.media_id} - ${error.message}`);
      }
    }
  }

  if (successCount > 10) {
    console.log(`   ✅ 共成功加入队列 ${successCount} 张图片`);
  }

  if (skippedCount > 0) {
    console.log(`   ⏭️  跳过 ${skippedCount} 张（已在队列中）`);
  }

  if (failCount > 3) {
    console.log(`   ❌ 共失败 ${failCount} 张图片`);
  }

  return { successCount, skippedCount, failCount, errors };
}

/**
 * 检查队列状态
 */
async function checkQueueStatus() {
  console.log("\n📊 步骤4: 检查队列状态...");

  try {
    const jobCounts = await searchIndexQueue.getJobCounts();

    console.log(`   📋 当前队列状态:`);
    console.log(`      等待处理: ${jobCounts.waiting}`);
    console.log(`      正在处理: ${jobCounts.active}`);
    console.log(`      已完成: ${jobCounts.completed}`);
    console.log(`      失败: ${jobCounts.failed}`);
    console.log(`      延迟: ${jobCounts.delayed}`);

    const totalPending = jobCounts.waiting + jobCounts.active + jobCounts.delayed;

    if (totalPending > 0) {
      console.log(`\n   ⏱️  预计处理时间: ${Math.ceil(totalPending / 1)} 分钟（假设每张图片1分钟）`);
      console.log(`   💡 提示: 确保 search-index-worker 和 Python AI 服务正在运行`);
    }

    return jobCounts;
  } catch (error) {
    console.log(`   ⚠️  无法获取队列状态: ${error.message}`);
    return null;
  }
}

/**
 * 验证配置
 */
function verifyConfiguration() {
  console.log("\n🔧 步骤0: 验证配置...");

  const enableAI = process.env.ENABLE_AI_ANALYSIS !== "false";
  const queueName = process.env.SEARCH_INDEX_QUEUE_NAME;

  console.log(`   AI分析功能: ${enableAI ? "✅ 已启用" : "❌ 已禁用"}`);
  console.log(`   队列名称: ${queueName || "❌ 未配置"}`);

  if (!enableAI) {
    console.log(`\n   ⚠️  警告: AI分析功能已禁用 (ENABLE_AI_ANALYSIS=false)`);
    console.log(`   💡 提示: 图片将被加入队列，但不会被处理`);
    console.log(`   💡 建议: 修改 .env 文件，设置 ENABLE_AI_ANALYSIS=true`);
    console.log(``);

    // 询问是否继续
    return false;
  }

  if (!queueName) {
    console.log(`\n   ❌ 错误: 队列名称未配置`);
    console.log(`   💡 提示: 请在 .env 文件中设置 SEARCH_INDEX_QUEUE_NAME`);
    return false;
  }

  console.log(`   ✅ 配置验证通过`);
  return true;
}

/**
 * 主函数
 */
async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         🤖 批量AI分析队列加入脚本                             ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("📝 功能: 将未进行AI分析的图片批量加入队列");
  console.log("🎯 目标: 触发Python AI服务进行人脸识别分析");
  console.log("");

  try {
    // 步骤0: 验证配置
    const configOk = verifyConfiguration();
    if (!configOk) {
      console.log("\n⚠️  配置验证失败，脚本终止");
      console.log("💡 请修复配置后重新运行");
      process.exit(1);
    }

    // 步骤1: 查询需要AI分析的图片
    const needingAI = findImagesNeedingAI();

    if (needingAI.length === 0) {
      console.log("\n✅ 所有图片都已进行AI分析，无需处理");
      console.log("💡 提示: 如果确实有图片未分析，请检查数据库字段 person_count");
      return;
    }

    console.log(`\n📊 准备将 ${needingAI.length} 张图片加入队列`);
    console.log("⏳ 开始执行加入操作...\n");

    // 步骤2: 检查并处理失败的任务
    const failedJobsResult = await handleFailedJobs();

    // 步骤3: 批量加入队列
    const enqueueResult = await enqueueForAIAnalysis(needingAI);

    // 步骤4: 检查队列状态
    await checkQueueStatus();

    // 输出统计结果
    console.log("\n╔═══════════════════════════════════════════════════════════════╗");
    console.log("║         📊 加入队列统计结果                                   ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝");
    console.log("");
    console.log(`📋 需要AI分析的图片数:    ${needingAI.length}`);
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
      console.log("⚠️  加入队列失败详情:");
      enqueueResult.errors.forEach((err) => {
        console.log(`   - 图片ID ${err.imageId} (用户${err.userId}): ${err.error}`);
      });
      console.log("");
    }

    if (enqueueResult.successCount > 0) {
      console.log("╔═══════════════════════════════════════════════════════════════╗");
      console.log("║         🎉 加入队列完成！                                     ║");
      console.log("╚═══════════════════════════════════════════════════════════════╝");
      console.log("");
      console.log("✅ 图片已加入AI分析队列");
      console.log("");
      console.log("📋 后续步骤:");
      console.log("   1. 确保 search-index-worker 正在运行: pm2 list");
      console.log("   2. 确保 Python AI 服务正在运行: ps aux | grep python");
      console.log("   3. 查看处理日志: pm2 logs search-index-worker");
      console.log("   4. 监控队列进度: 可查看数据库 person_count 字段更新情况");
      console.log("");
    }
  } catch (error) {
    console.error("\n❌ 脚本执行过程中发生错误：", error);
    console.error("Stack:", error.stack);
    throw error;
  } finally {
    // 关闭队列连接
    try {
      const { closeSearchIndexQueue } = require(path.join(projectRoot, "src", "queues", "searchIndexQueue"));
      await closeSearchIndexQueue();
    } catch (e) {
      // 忽略关闭错误
    }
  }
}

// 执行脚本
main()
  .then(() => {
    console.log("✅ 脚本执行完成");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 脚本执行失败：", error.message);
    process.exit(1);
  });
