# scripts/development/ — 开发与日常运维

本目录为**开发与日常运维**脚本：队列重试、定时任务、批量入队、队列/Redis 运维、数据清理等。  
部署相关脚本在 **scripts/deployment/**。

---

## 所有脚本及作用

### 队列

| 脚本                     | 作用                                                                              | 调用方式                                                                |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **retry-failed-jobs.js** | 重试 BullMQ 失败任务：upload / meta / search / cleanup 四队列，可指定单队列或 all | `node scripts/development/retry-failed-jobs.js [queueName]`，默认 `all` |
| **clear-queues.js**      | 清空 BullMQ 队列：--upload / --meta / --search / --cleanup，不传或 --all 清空全部 | `node scripts/development/clear-queues.js [选项]`                       |
| **clear-redis-cache.js** | 清空 Redis 业务数据：队列、用户哈希集合、上传会话、锁、缓存等（生产慎用）         | `node scripts/development/clear-redis-cache.js`                         |

### 数据清理

| 脚本                    | 作用                                                                                                                                                              | 调用方式                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **clear-image-data.js** | 按选项清理：--clear-storage（库表+本地/OSS 文件）、--clear-queues（四队列）、--clear-redis（业务键），--clear-all 为全部；server-deploy.sh 的 --clear-data 会调用 | `node scripts/development/clear-image-data.js [选项]` |

### PM2 定时任务（ecosystem.config.js 已配置）

| 脚本                          | 作用                                               | 触发方式                                                                    |
| ----------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| **rebuild-similar-groups.js** | 全量重建相似图分组与模糊图标记，供清理页「相似图」 | 每天 3:00 cron，或手动 `node scripts/development/rebuild-similar-groups.js` |
| **rebuild-face-clusters.js**  | 全量人脸聚类：为所有用户执行人脸聚类并更新结果     | 每天 3:00 cron，或手动 `node scripts/development/rebuild-face-clusters.js`  |

### 批量入队（补数 / 手动触发 AI 或清理分析）

| 脚本                            | 作用                                                    | 调用方式                                               |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| **enqueue-ai-analysis.js**      | 将「有高清图但未做 AI 分析」的图片加入 searchIndexQueue | `node scripts/development/enqueue-ai-analysis.js`      |
| **enqueue-cleanup-analysis.js** | 将「未生成清理指标」的图片加入 cleanupQueue             | `node scripts/development/enqueue-cleanup-analysis.js` |
