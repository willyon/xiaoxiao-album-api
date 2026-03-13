/*
 * @Author: zhangshouchang
 * @Date: 2025-11-02
 * @Description: 清空所有 Redis 缓存数据的脚本
 *
 * ⚠️ 警告：此脚本会清空以下所有 Redis 数据：
 * • BullMQ 队列数据（等待、活跃、完成、失败任务）
 * • 用户图片哈希集合（去重数据）
 * • 上传会话数据
 * • 图片处理锁
 * • 其他所有缓存数据
 *
 * 使用场景：
 * • 本地开发环境重置
 * • 清理测试数据
 * • 解决缓存不一致问题
 *
 * ⚠️ 生产环境慎用！
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const { getRedisClient } = require(path.join(projectRoot, "src", "services", "redisClient"));
const { mediaUploadQueue, closeMediaUploadQueue } = require(path.join(projectRoot, "src", "queues", "mediaUploadQueue"));
const { mediaMetaQueue, closeMediaMetaQueue } = require(path.join(projectRoot, "src", "queues", "mediaMetaQueue"));
const { searchIndexQueue, closeSearchIndexQueue } = require(path.join(projectRoot, "src", "queues", "searchIndexQueue"));

/**
 * 清空 BullMQ 队列数据
 */
async function clearBullMQQueues() {
  console.log("\n📋 步骤1: 清空 BullMQ 队列数据...");

  try {
    // 清空上传队列
    console.log("  📤 清空图片上传队列...");
    const uploadStats = {
      waiting: await mediaUploadQueue.clean(0, 10000, "waiting"),
      active: await mediaUploadQueue.clean(0, 10000, "active"),
      completed: await mediaUploadQueue.clean(0, 10000, "completed"),
      failed: await mediaUploadQueue.clean(0, 10000, "failed"),
      delayed: await mediaUploadQueue.clean(0, 10000, "delayed"),
    };
    await mediaUploadQueue.drain(true);
    console.log(
      `     ✅ 清理: 等待${uploadStats.waiting} | 活跃${uploadStats.active} | 完成${uploadStats.completed} | 失败${uploadStats.failed} | 延迟${uploadStats.delayed}`,
    );

    // 清空元数据队列
    console.log("  📊 清空图片元数据队列...");
    const metaStats = {
      waiting: await mediaMetaQueue.clean(0, 10000, "waiting"),
      active: await mediaMetaQueue.clean(0, 10000, "active"),
      completed: await mediaMetaQueue.clean(0, 10000, "completed"),
      failed: await mediaMetaQueue.clean(0, 10000, "failed"),
      delayed: await mediaMetaQueue.clean(0, 10000, "delayed"),
    };
    await mediaMetaQueue.drain(true);
    console.log(
      `     ✅ 清理: 等待${metaStats.waiting} | 活跃${metaStats.active} | 完成${metaStats.completed} | 失败${metaStats.failed} | 延迟${metaStats.delayed}`,
    );

    // 清空搜索索引队列
    console.log("  👤 清空搜索索引队列...");
    const searchStats = {
      waiting: await searchIndexQueue.clean(0, 10000, "waiting"),
      active: await searchIndexQueue.clean(0, 10000, "active"),
      completed: await searchIndexQueue.clean(0, 10000, "completed"),
      failed: await searchIndexQueue.clean(0, 10000, "failed"),
      delayed: await searchIndexQueue.clean(0, 10000, "delayed"),
    };
    await searchIndexQueue.drain(true);
    console.log(
      `     ✅ 清理: 等待${searchStats.waiting} | 活跃${searchStats.active} | 完成${searchStats.completed} | 失败${searchStats.failed} | 延迟${searchStats.delayed}`,
    );

    console.log("  ✅ BullMQ 队列数据清理完成");
  } catch (err) {
    console.error("  ❌ 清空 BullMQ 队列失败：", err.message);
    throw err;
  }
}

/**
 * 清空用户相关的 Redis 缓存数据
 */
async function clearUserRelatedCache(redisClient) {
  console.log("\n👥 步骤2: 清空用户相关缓存数据...");

  try {
    let deletedCount = 0;

    // 1. 清空用户图片哈希集合 (images:hashset:user:*)
    console.log("  🖼️  清空用户图片哈希集合...");
    const hashsetKeys = await redisClient.keys("images:hashset:user:*");
    if (hashsetKeys.length > 0) {
      deletedCount += await redisClient.del(...hashsetKeys);
    }
    console.log(`     ✅ 删除 ${hashsetKeys.length} 个图片哈希集合`);

    // 2. 清空哈希集合准备状态 (images:hashset:ready:*)
    console.log("  🔄 清空哈希集合准备状态...");
    const readyKeys = await redisClient.keys("images:hashset:ready:*");
    if (readyKeys.length > 0) {
      deletedCount += await redisClient.del(...readyKeys);
    }
    console.log(`     ✅ 删除 ${readyKeys.length} 个准备状态`);

    // 3. 清空哈希集合锁 (lock:images:hashset:init:*)
    console.log("  🔒 清空哈希集合锁...");
    const hashLockKeys = await redisClient.keys("lock:images:hashset:init:*");
    if (hashLockKeys.length > 0) {
      deletedCount += await redisClient.del(...hashLockKeys);
    }
    console.log(`     ✅ 删除 ${hashLockKeys.length} 个哈希集合锁`);

    // 4. 清空图片处理锁 (使用环境变量中的前缀)
    const lockPrefix = process.env.MEDIA_HASH_LOCK_KEY_PREFIX || "img:lock:";
    console.log(`  🔐 清空图片处理锁 (${lockPrefix}*)...`);
    const imageLockKeys = await redisClient.keys(`${lockPrefix}*`);
    if (imageLockKeys.length > 0) {
      deletedCount += await redisClient.del(...imageLockKeys);
    }
    console.log(`     ✅ 删除 ${imageLockKeys.length} 个图片处理锁`);

    // 5. 清空上传会话数据 (upload:session:*)
    console.log("  📦 清空上传会话数据...");
    const sessionKeys = await redisClient.keys("upload:session:*");
    if (sessionKeys.length > 0) {
      deletedCount += await redisClient.del(...sessionKeys);
    }
    console.log(`     ✅ 删除 ${sessionKeys.length} 个上传会话`);

    // 6. 清空用户最新会话记录 (user:latest:session:*)
    console.log("  🆕 清空用户最新会话记录...");
    const latestSessionKeys = await redisClient.keys("user:latest:session:*");
    if (latestSessionKeys.length > 0) {
      deletedCount += await redisClient.del(...latestSessionKeys);
    }
    console.log(`     ✅ 删除 ${latestSessionKeys.length} 个最新会话记录`);

    // 7. 清空会话进度推送频道 (session:*:progress)
    console.log("  📡 清空会话进度推送数据...");
    const progressKeys = await redisClient.keys("session:*:progress");
    if (progressKeys.length > 0) {
      deletedCount += await redisClient.del(...progressKeys);
    }
    console.log(`     ✅ 删除 ${progressKeys.length} 个进度推送数据`);

    console.log(`  ✅ 用户相关缓存数据清理完成 (共删除 ${deletedCount} 个key)`);
  } catch (err) {
    console.error("  ❌ 清空用户相关缓存失败：", err.message);
    throw err;
  }
}

/**
 * 清空认证相关的 Redis 缓存数据
 */
async function clearAuthRelatedCache(redisClient) {
  console.log("\n🔑 步骤3: 清空认证相关缓存数据...");

  try {
    let deletedCount = 0;

    // 1. 清空 refresh token (refresh_token:*)
    console.log("  🎫 清空 refresh token...");
    const refreshTokenKeys = await redisClient.keys("refresh_token:*");
    if (refreshTokenKeys.length > 0) {
      deletedCount += await redisClient.del(...refreshTokenKeys);
    }
    console.log(`     ✅ 删除 ${refreshTokenKeys.length} 个 refresh token`);

    // 2. 清空冷却时间数据 (cooldown:*)
    console.log("  ⏱️  清空冷却时间数据...");
    const cooldownKeys = await redisClient.keys("cooldown:*");
    if (cooldownKeys.length > 0) {
      deletedCount += await redisClient.del(...cooldownKeys);
    }
    console.log(`     ✅ 删除 ${cooldownKeys.length} 个冷却时间记录`);

    console.log(`  ✅ 认证相关缓存数据清理完成 (共删除 ${deletedCount} 个key)`);
  } catch (err) {
    console.error("  ❌ 清空认证相关缓存失败：", err.message);
    throw err;
  }
}

/**
 * 清空所有其他 Redis 数据（可选）
 */
async function clearOtherCache(redisClient) {
  console.log("\n🗑️  步骤4: 检查其他 Redis 数据...");

  try {
    // 获取所有剩余的key
    const allKeys = await redisClient.keys("*");

    // 过滤出已知的 BullMQ 相关 key（不在上面步骤中处理的）
    const bullKeys = allKeys.filter((key) => key.startsWith("bull:"));

    // 其他未分类的key
    const otherKeys = allKeys.filter((key) => !key.startsWith("bull:"));

    if (bullKeys.length > 0) {
      console.log(`  ℹ️  发现 ${bullKeys.length} 个 BullMQ 相关key（已在步骤1中处理）`);
    }

    if (otherKeys.length > 0) {
      console.log(`  ⚠️  发现 ${otherKeys.length} 个其他未分类的key:`);
      otherKeys.slice(0, 10).forEach((key) => console.log(`     - ${key}`));
      if (otherKeys.length > 10) {
        console.log(`     ... 还有 ${otherKeys.length - 10} 个`);
      }
      console.log(`  💡 提示: 如需清空所有数据，请手动执行: redis-cli FLUSHDB`);
    } else {
      console.log(`  ✅ 没有发现其他未分类的数据`);
    }
  } catch (err) {
    console.error("  ❌ 检查其他缓存失败：", err.message);
  }
}

/**
 * 主函数
 */
async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         🧹 清空 Redis 缓存数据脚本                             ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("⚠️  警告: 此脚本将清空所有 Redis 缓存数据！");
  console.log("   包括: BullMQ队列、用户哈希集合、会话数据、认证数据等");
  console.log("");

  const redisClient = getRedisClient();

  try {
    // 等待 Redis 连接就绪
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 步骤1: 清空 BullMQ 队列
    await clearBullMQQueues();

    // 步骤2: 清空用户相关缓存
    await clearUserRelatedCache(redisClient);

    // 步骤3: 清空认证相关缓存
    await clearAuthRelatedCache(redisClient);

    // 步骤4: 检查其他数据
    await clearOtherCache(redisClient);

    console.log("\n╔═══════════════════════════════════════════════════════════════╗");
    console.log("║         🎉 Redis 缓存清理完成！                                ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("✅ 所有 Redis 缓存数据已清空");
    console.log("💡 提示: 如需完全清空 Redis，请手动执行: redis-cli FLUSHDB");
    console.log("");
  } catch (error) {
    console.error("\n❌ Redis 缓存清理失败：", error);
    throw error;
  } finally {
    // 关闭所有连接
    await closeMediaUploadQueue().catch(() => {});
    await closeMediaMetaQueue().catch(() => {});
    await closeSearchIndexQueue().catch(() => {});

    if (redisClient) {
      await redisClient.quit().catch(() => {});
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
    console.error("❌ 脚本执行失败：", error);
    process.exit(1);
  });
