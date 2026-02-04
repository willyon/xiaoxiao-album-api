#!/usr/bin/env node
/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 定时任务脚本 - 为所有用户执行人脸聚类
 *
 * 📋 功能说明:
 * • 获取所有用户ID
 * • 为每个用户执行人脸聚类
 * • 记录执行日志
 *
 * 🚀 使用方式:
 * • 通过 PM2 cron 定时执行（每天凌晨3点）
 * • 手动执行: node scripts/development/rebuild-face-clusters.js
 */

require("dotenv").config();
const { db } = require("../../src/services/database");
const faceClusterService = require("../../src/services/faceClusterService");
const logger = require("../../src/utils/logger");

/**
 * 获取所有用户ID
 * @returns {Array<number>} 用户ID列表
 */
function getAllUserIds() {
  const sql = `SELECT id FROM users ORDER BY id ASC`;
  const stmt = db.prepare(sql);
  const rows = stmt.all();
  return rows.map((row) => row.id);
}

/**
 * 主函数：为所有用户执行人脸聚类
 */
async function main() {
  const startTime = Date.now();
  logger.info({
    message: "🚀 开始执行全量人脸聚类任务",
    timestamp: new Date().toISOString(),
  });

  try {
    // 1. 获取所有用户ID
    const userIds = getAllUserIds();
    logger.info({
      message: `获取到 ${userIds.length} 个用户`,
      details: { userCount: userIds.length },
    });

    if (userIds.length === 0) {
      logger.info({
        message: "没有用户需要执行聚类",
      });
      return;
    }

    // 2. 为每个用户执行聚类
    const results = {
      total: userIds.length,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    for (const userId of userIds) {
      try {
        logger.info({
          message: `开始为用户 ${userId} 执行人脸聚类`,
          details: { userId },
        });

        const result = await faceClusterService.performFaceClustering({
          userId,
          recluster: true, // 重新聚类，删除旧数据
        });

        if (result.success) {
          // 服务在「无数据」时也返回 success: true，用 clusterCount/totalFaces 区分
          const hasData = (result.clusterCount ?? 0) > 0 || (result.totalFaces ?? 0) > 0;
          if (hasData) {
            results.success++;
            logger.info({
              message: `✅ 用户 ${userId} 人脸聚类完成`,
              details: {
                userId,
                clusterCount: result.clusterCount,
                totalFaces: result.totalFaces,
              },
            });
          } else {
            results.skipped++;
            logger.info({
              message: `⏭️ 用户 ${userId} 跳过聚类（无数据）`,
              details: { userId, message: result.message },
            });
          }
        } else {
          results.skipped++;
          logger.info({
            message: `⏭️ 用户 ${userId} 跳过聚类（无数据）`,
            details: { userId, message: result.message },
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          userId,
          error: error.message,
        });
        logger.error({
          message: `❌ 用户 ${userId} 人脸聚类失败`,
          details: {
            userId,
            error: error.message,
            stack: error.stack,
          },
        });
      }
    }

    // 3. 输出统计结果
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info({
      message: "🎉 全量人脸聚类任务完成",
      details: {
        total: results.total,
        success: results.success,
        failed: results.failed,
        skipped: results.skipped,
        elapsedSeconds: elapsed,
        errors: results.errors.length > 0 ? results.errors : undefined,
      },
    });

    // 如果有错误，以非零状态码退出（方便 PM2 监控）
    if (results.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error({
      message: "❌ 全量人脸聚类任务执行失败",
      details: {
        error: error.message,
        stack: error.stack,
      },
    });
    process.exit(1);
  }
}

// 执行主函数
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error({
      message: "未捕获的异常",
      details: {
        error: error.message,
        stack: error.stack,
      },
    });
    process.exit(1);
  });
