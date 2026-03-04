#!/usr/bin/env node
/**
 * 音频上传链路诊断脚本
 * 用于排查「上传音频后刷新页面看不到」的问题
 *
 * 用法: node scripts/tmp-scripts/diagnose-audio-upload.js
 */
require("dotenv").config();
const path = require("path");

async function main() {
  console.log("\n========== 音频上传链路诊断 ==========\n");

  const issues = [];
  const ok = [];

  // 1. 检查 Redis 连接
  try {
    const Redis = require("ioredis");
    const redis = new Redis({ maxRetriesPerRequest: null });
    await redis.ping();
    ok.push("✓ Redis 连接正常");
    redis.disconnect();
  } catch (e) {
    issues.push(`✗ Redis 连接失败: ${e.message}`);
    console.log("  Redis 未运行或配置错误，Worker 无法处理上传队列！");
  }

  // 2. 检查队列中的待处理任务
  try {
    const { imageUploadQueue } = require("../../src/queues/imageUploadQueue");
    const [waiting, active] = await Promise.all([
      imageUploadQueue.getWaitingCount(),
      imageUploadQueue.getActiveCount(),
    ]);
    if (waiting > 0 || active > 0) {
      issues.push(`✗ 上传队列中有 ${waiting} 个等待 + ${active} 个正在处理的任务`);
      console.log("  说明: 有文件已上传但尚未被 Worker 处理完成。请确保 image-upload-worker 和 image-meta-worker 正在运行！");
    } else {
      ok.push("✓ 上传队列无积压");
    }
    await imageUploadQueue.close();
  } catch (e) {
    if (e.code !== "ECONNREFUSED") {
      issues.push(`✗ 检查队列失败: ${e.message}`);
    }
  }

  // 3. 检查数据库中的音频记录
  try {
    const { db } = require("../../src/services/database");
    const audioCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM images 
      WHERE media_type = 'audio' AND deleted_at IS NULL
    `).get();
    const recentAudio = db.prepare(`
      SELECT id, image_hash, created_at, original_storage_key, 
             image_created_at, month_key, year_key
      FROM images 
      WHERE media_type = 'audio' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 5
    `).all();

    ok.push(`✓ 数据库中共有 ${audioCount.cnt} 条音频记录`);
    if (recentAudio.length > 0) {
      console.log("\n  最近 5 条音频:");
      recentAudio.forEach((r, i) => {
        console.log(`    ${i + 1}. id=${r.id} hash=${r.image_hash?.slice(0, 12)}... created=${new Date(r.created_at).toLocaleString()}`);
        console.log(`       original_storage_key: ${r.original_storage_key || "(null)"}`);
        console.log(`       year_key/month_key: ${r.year_key}/${r.month_key}`);
      });
    }
  } catch (e) {
    issues.push(`✗ 数据库查询失败: ${e.message}`);
  }

  // 4. 检查 Worker 进程
  console.log("\n--- Worker 进程检查 ---");
  console.log("  请确保以下 Worker 正在运行（否则上传后队列任务不会被处理）:");
  console.log("    • image-upload-worker  (imageUploadWorker.js)");
  console.log("    • image-meta-worker    (imageMetaWorker.js)");
  console.log("  若使用 PM2: pm2 list | grep -E 'upload-worker|meta-worker'");
  console.log("  若使用 npm run dev: 仅启动 API，需单独启动 Worker！");

  // 5. 汇总
  console.log("\n========== 诊断结果 ==========");
  ok.forEach((o) => console.log("  " + o));
  issues.forEach((i) => console.log("  " + i));

  if (issues.length > 0) {
    console.log("\n💡 常见原因:");
    console.log("  1. Worker 未启动 → 上传后任务堆积在 Redis，数据库无记录");
    console.log("  2. Redis 重启后队列清空 → 正在处理的任务丢失");
    console.log("  3. 前端 mediaType 筛选为「仅图片」→ 需改为「全部」才能看到音频");
    console.log("  4. 音频 meta 处理失败 → 检查 image-meta-worker 日志");
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
