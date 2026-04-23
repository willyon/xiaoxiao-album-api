/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 完整服务 PM2 配置 - 生产环境
 *
 * 🚀 包含服务:
 * • Node.js API 服务
 * • Node.js Workers (图片上传、元数据处理、云模型字幕、搜索索引)
 * • Python AI 服务 (人脸识别、图片理解等)
 */
const path = require('path')
const APP_ROOT = path.resolve(__dirname)

module.exports = {
  apps: [
    // ========== Node.js 服务 ==========
    {
      name: 'app-service',
      script: 'server.js',
      node_args: '-r dotenv/config',
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'media-upload-worker',
      script: 'src/workers/mediaUploadWorker.js',
      node_args: '-r dotenv/config',
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'media-meta-worker',
      script: 'src/workers/mediaMetaWorker.js',
      node_args: '-r dotenv/config',
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'cloud-caption-worker',
      script: 'src/workers/cloudCaptionWorker.js',
      node_args: '-r dotenv/config',
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'map-regeo-worker',
      script: 'src/workers/mapRegeoWorker.js',
      node_args: '-r dotenv/config',
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}

/*
🚀 使用说明:

📋 生产环境启动:
pm2 start ecosystem.config.js

📋 常用命令:
- 启动所有服务: pm2 start ecosystem.config.js
- 重启所有服务: pm2 restart all
- 停止所有服务: pm2 stop all
- 查看状态: pm2 list
- 查看日志: pm2 logs
- 查看特定服务日志: pm2 logs app-service

📋 单独管理服务:
- 重启 API 服务: pm2 restart app-service
- 重启 Python AI 服务: pm2 restart python-ai-service
- 重启所有 Workers: pm2 restart media-upload-worker media-meta-worker cloud-caption-worker media-analysis-worker

说明：相似分组重建（rebuildCleanupGroups）与人脸聚类（performFaceClustering）在媒体分析成功路径中已由 mediaAnalysisIngestor 去抖调度（scheduleUserRebuild / scheduleUserClustering），无需 PM2 重复定时跑。

📋 监控命令:
- 实时监控: pm2 monit
- 查看进程信息: pm2 show app-service
- 查看错误日志: pm2 logs --err
*/
