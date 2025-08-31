#!/usr/bin/env node

/*
 * @Author: zhangshouchang
 * @Date: 2025-01-01
 * @Description: BullMQ 队列监控工具
 *
 * 使用方法：
 * node scripts/queueMonitor.js                    # 显示所有队列状态
 * node scripts/queueMonitor.js --queue upload     # 只显示上传队列
 * node scripts/queueMonitor.js --queue meta       # 只显示元数据队列
 * node scripts/queueMonitor.js --watch            # 实时监控模式
 * node scripts/queueMonitor.js --jobs             # 显示详细任务信息
 */

require("dotenv").config();
const { Queue } = require("bullmq");
const Redis = require("ioredis");

// Redis 连接
const connection = new Redis({
  maxRetriesPerRequest: null,
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
});

// 队列配置
const QUEUES = {
  upload: {
    name: process.env.IMAGE_UPLOAD_QUEUE_NAME || "imageUploadQueue",
    displayName: "图片上传队列",
  },
  meta: {
    name: process.env.IMAGE_META_QUEUE_NAME || "imageMetaQueue",
    displayName: "图片元数据队列",
  },
};

class QueueMonitor {
  constructor() {
    this.queues = {};
    this.initQueues();
  }

  initQueues() {
    Object.keys(QUEUES).forEach((key) => {
      this.queues[key] = new Queue(QUEUES[key].name, { connection });
    });
  }

  /**
   * 获取队列统计信息
   */
  async getQueueStats(queueKey) {
    const queue = this.queues[queueKey];
    const queueConfig = QUEUES[queueKey];

    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed(),
        queue.getDelayed(),
      ]);

      return {
        name: queueConfig.displayName,
        queueName: queueConfig.name,
        stats: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length,
          delayed: delayed.length,
          total: waiting.length + active.length + completed.length + failed.length + delayed.length,
        },
        jobs: {
          waiting: waiting.slice(0, 10), // 只取前10个
          active: active.slice(0, 10),
          failed: failed.slice(0, 5),
        },
      };
    } catch (error) {
      return {
        name: queueConfig.displayName,
        queueName: queueConfig.name,
        error: error.message,
      };
    }
  }

  /**
   * 显示队列状态概览
   */
  async showQueueOverview(targetQueue = null) {
    console.log("\n🔍 队列状态监控");
    console.log("=".repeat(60));
    console.log(`📅 时间: ${new Date().toLocaleString()}`);
    console.log("=".repeat(60));

    const queueKeys = targetQueue ? [targetQueue] : Object.keys(QUEUES);

    for (const queueKey of queueKeys) {
      if (!this.queues[queueKey]) {
        console.log(`❌ 队列 "${queueKey}" 不存在`);
        continue;
      }

      const stats = await this.getQueueStats(queueKey);

      if (stats.error) {
        console.log(`❌ ${stats.name}: ${stats.error}`);
        continue;
      }

      console.log(`\n📋 ${stats.name} (${stats.queueName})`);
      console.log("-".repeat(40));
      console.log(`⏳ 等待中: ${stats.stats.waiting}`);
      console.log(`🔄 处理中: ${stats.stats.active}`);
      console.log(`✅ 已完成: ${stats.stats.completed}`);
      console.log(`❌ 已失败: ${stats.stats.failed}`);
      console.log(`⏰ 延迟中: ${stats.stats.delayed}`);
      console.log(`📊 总计: ${stats.stats.total}`);
    }
  }

  /**
   * 显示详细任务信息
   */
  async showJobDetails(targetQueue = null) {
    console.log("\n📝 详细任务信息");
    console.log("=".repeat(60));

    const queueKeys = targetQueue ? [targetQueue] : Object.keys(QUEUES);

    for (const queueKey of queueKeys) {
      if (!this.queues[queueKey]) continue;

      const stats = await this.getQueueStats(queueKey);
      if (stats.error) continue;

      console.log(`\n📋 ${stats.name}`);
      console.log("-".repeat(40));

      // 显示等待中的任务
      if (stats.jobs.waiting.length > 0) {
        console.log("\n⏳ 等待中的任务:");
        stats.jobs.waiting.forEach((job, index) => {
          console.log(`  ${index + 1}. ID: ${job.id} | 数据: ${this.formatJobData(job.data)}`);
        });
      }

      // 显示处理中的任务
      if (stats.jobs.active.length > 0) {
        console.log("\n🔄 处理中的任务:");
        stats.jobs.active.forEach((job, index) => {
          console.log(`  ${index + 1}. ID: ${job.id} | 数据: ${this.formatJobData(job.data)} | 进度: ${job.progress || 0}%`);
        });
      }

      // 显示失败的任务
      if (stats.jobs.failed.length > 0) {
        console.log("\n❌ 最近失败的任务:");
        stats.jobs.failed.forEach((job, index) => {
          console.log(`  ${index + 1}. ID: ${job.id} | 数据: ${this.formatJobData(job.data)} | 错误: ${job.failedReason || "Unknown"}`);
        });
      }
    }
  }

  /**
   * 格式化任务数据显示
   */
  formatJobData(data) {
    if (!data) return "N/A";

    // 提取关键信息
    const key = data.filename || data.imageHash || data.userId || "Unknown";
    const type = data.storageKey ? "Storage" : data.userId ? "User" : "Unknown";

    return `${type}:${key}`;
  }

  /**
   * 实时监控模式
   */
  async watchMode(targetQueue = null) {
    console.log("🔄 开始实时监控模式 (按 Ctrl+C 退出)");

    const refresh = async () => {
      // 清屏
      console.clear();
      await this.showQueueOverview(targetQueue);
    };

    // 初始显示
    await refresh();

    // 每5秒刷新一次
    const interval = setInterval(refresh, 5000);

    // 优雅退出
    process.on("SIGINT", () => {
      console.log("\n👋 监控已停止");
      clearInterval(interval);
      this.close();
      process.exit(0);
    });
  }

  /**
   * 清理队列（危险操作）
   */
  async cleanQueue(queueKey, type = "failed") {
    if (!this.queues[queueKey]) {
      console.log(`❌ 队列 "${queueKey}" 不存在`);
      return;
    }

    const queue = this.queues[queueKey];
    const queueConfig = QUEUES[queueKey];

    console.log(`🧹 清理队列 ${queueConfig.displayName} 中的 ${type} 任务...`);

    try {
      let count = 0;
      switch (type) {
        case "failed":
          count = await queue.clean(0, 1000, "failed");
          break;
        case "completed":
          count = await queue.clean(0, 1000, "completed");
          break;
        case "all":
          const failedCount = await queue.clean(0, 1000, "failed");
          const completedCount = await queue.clean(0, 1000, "completed");
          count = failedCount + completedCount;
          break;
        default:
          console.log(`❌ 不支持的清理类型: ${type}`);
          return;
      }

      console.log(`✅ 已清理 ${count} 个任务`);
    } catch (error) {
      console.log(`❌ 清理失败: ${error.message}`);
    }
  }

  /**
   * 关闭连接
   */
  async close() {
    for (const queue of Object.values(this.queues)) {
      await queue.close();
    }
    await connection.quit();
  }
}

// 命令行参数处理
async function main() {
  const args = process.argv.slice(2);
  const monitor = new QueueMonitor();

  try {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`
🔍 BullMQ 队列监控工具

使用方法:
  node scripts/queueMonitor.js                    # 显示所有队列状态
  node scripts/queueMonitor.js --queue upload     # 只显示上传队列  
  node scripts/queueMonitor.js --queue meta       # 只显示元数据队列
  node scripts/queueMonitor.js --watch            # 实时监控模式
  node scripts/queueMonitor.js --jobs             # 显示详细任务信息
  node scripts/queueMonitor.js --clean failed     # 清理失败任务
  node scripts/queueMonitor.js --clean completed  # 清理完成任务

参数说明:
  --queue <name>    指定队列 (upload, meta)
  --watch           实时监控模式
  --jobs            显示详细任务信息
  --clean <type>    清理队列 (failed, completed, all)
  --help, -h        显示帮助信息
      `);
      return;
    }

    const queueIndex = args.indexOf("--queue");
    const targetQueue = queueIndex !== -1 ? args[queueIndex + 1] : null;

    if (args.includes("--watch")) {
      await monitor.watchMode(targetQueue);
    } else if (args.includes("--jobs")) {
      await monitor.showJobDetails(targetQueue);
    } else if (args.includes("--clean")) {
      const cleanIndex = args.indexOf("--clean");
      const cleanType = cleanIndex !== -1 ? args[cleanIndex + 1] : "failed";
      const queue = targetQueue || "upload"; // 默认清理上传队列
      await monitor.cleanQueue(queue, cleanType);
    } else {
      await monitor.showQueueOverview(targetQueue);
    }
  } catch (error) {
    console.error("❌ 监控出错:", error.message);
  } finally {
    await monitor.close();
  }
}

// 运行
if (require.main === module) {
  main().catch(console.error);
}

module.exports = QueueMonitor;
