/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 完整服务 PM2 配置 - 开发环境
 *
 * 🚀 包含服务:
 * • Node.js API 服务 (开发版)
 * • Node.js Workers (开发版，含云模型字幕 Worker)
 * • Python AI 服务 (开发版 - 人脸识别、图片理解等)
 */
const path = require('path')
// 固定为「本配置文件所在目录」，避免仅改文件夹名后 cwd 仍为旧路径或相对 '.' 解析错误
const APP_ROOT = path.resolve(__dirname)

module.exports = {
  apps: [
    // ========== Node.js 服务 (开发版) ==========
    {
      name: 'app-service-dev',
      script: 'server.js',
      node_args: '-r dotenv/config',
      // cwd: 与 ecosystem 文件同目录（APP_ROOT），保证改名/从任意目录 pm2 start 仍正确
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'media-upload-worker-dev',
      script: 'src/workers/mediaUploadWorker.js',
      node_args: '-r dotenv/config',
      // cwd: 与 ecosystem 文件同目录（APP_ROOT），保证改名/从任意目录 pm2 start 仍正确
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'media-meta-worker-dev',
      script: 'src/workers/mediaMetaWorker.js',
      node_args: '-r dotenv/config',
      // cwd: 与 ecosystem 文件同目录（APP_ROOT），保证改名/从任意目录 pm2 start 仍正确
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'media-analysis-worker-dev',
      script: 'src/workers/mediaAnalysisWorker.js',
      node_args: '-r dotenv/config',
      // cwd: 与 ecosystem 文件同目录（APP_ROOT），保证改名/从任意目录 pm2 start 仍正确
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'cloud-caption-worker-dev',
      script: 'src/workers/cloudCaptionWorker.js',
      node_args: '-r dotenv/config',
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'map-regeo-worker-dev',
      script: 'src/workers/mapRegeoWorker.js',
      node_args: '-r dotenv/config',
      cwd: APP_ROOT,
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: 'development'
      }
    }
  ]
}

/*
🚀 使用说明:

📋 开发环境启动:
pm2 start ecosystem.dev.config.js

📋 本地开发 (如果需要指定 Python 路径):
export PYTHON_SERVICE_PATH="/System/Volumes/Data/Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-album-ai"
pm2 start ecosystem.dev.config.js

📋 常用命令:
- 启动所有开发服务: pm2 start ecosystem.dev.config.js
- 重启所有开发服务: pm2 restart all
- 停止所有开发服务: pm2 stop all
- 查看状态: pm2 list
- 查看日志: pm2 logs

📋 单独管理开发服务:
- 重启 API 服务: pm2 restart app-service-dev
- 重启 Python AI 服务: pm2 restart python-ai-service-dev
- 重启所有 Workers: pm2 restart media-upload-worker-dev media-meta-worker-dev media-analysis-worker-dev cloud-caption-worker-dev

📋 开发调试:
- 查看 API 日志: pm2 logs app-service-dev
- 查看 Python AI 日志: pm2 logs python-ai-service-dev
- 查看 Worker 日志: pm2 logs media-upload-worker-dev
- 实时监控: pm2 monit

📋 定时任务管理 (开发版):
- 查看定时任务状态: pm2 list
- 查看清理任务日志: pm2 logs cleanup-rebuild-all-dev
- 查看聚类任务日志: pm2 logs face-cluster-rebuild-all-dev
- 手动执行清理任务: pm2 start cleanup-rebuild-all-dev --no-autorestart
- 手动执行聚类任务: pm2 start face-cluster-rebuild-all-dev --no-autorestart
- 停止定时任务: pm2 stop cleanup-rebuild-all-dev face-cluster-rebuild-all-dev
- 删除定时任务: pm2 delete cleanup-rebuild-all-dev face-cluster-rebuild-all-dev
- 注意: 开发环境如需频繁测试，可修改 cron 时间或注释掉 cron 字段手动执行
*/
