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
    },
    // ========== 定时任务 ==========
    {
      name: 'cleanup-rebuild-all',
      script: 'scripts/development/rebuild-similar-groups.js',
      node_args: '-r dotenv/config',
      cwd: APP_ROOT,
      // 定时执行：每天凌晨 3 点执行一次
      cron: '0 3 * * *',
      // 执行完成后自动退出，不常驻
      autorestart: false,
      watch: false,
      // 实例数：只运行一个实例
      instances: 1,
      // 执行模式：fork 模式（适合一次性脚本）
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      // 日志配置（如果 logs 目录不存在，PM2 会自动创建）
      error_file: './logs/cleanup-rebuild-all-error.log',
      out_file: './logs/cleanup-rebuild-all-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // 保留最近 10 天的日志
      log_file: './logs/cleanup-rebuild-all-combined.log',
      time: true
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

📋 定时任务管理:
- 查看定时任务状态: pm2 list
- 查看清理任务日志: pm2 logs cleanup-rebuild-all
- 查看聚类任务日志: pm2 logs face-cluster-rebuild-all
- 手动执行清理任务: pm2 start cleanup-rebuild-all --no-autorestart
- 手动执行聚类任务: pm2 start face-cluster-rebuild-all --no-autorestart
- 停止定时任务: pm2 stop cleanup-rebuild-all face-cluster-rebuild-all
- 删除定时任务: pm2 delete cleanup-rebuild-all face-cluster-rebuild-all

📋 监控命令:
- 实时监控: pm2 monit
- 查看进程信息: pm2 show app-service
- 查看错误日志: pm2 logs --err
*/
