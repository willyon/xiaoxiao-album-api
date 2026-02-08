/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 完整服务 PM2 配置 - 开发环境
 *
 * 🚀 包含服务:
 * • Node.js API 服务 (开发版)
 * • Node.js Workers (开发版)
 * • Python AI 服务 (开发版 - 人脸识别、OCR等)
 */
module.exports = {
  apps: [
    // ========== Node.js 服务 (开发版) ==========
    {
      name: "app-service-dev",
      script: "server.js",
      // cwd: 未设置，使用 PM2 启动目录
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "image-upload-worker-dev",
      script: "src/workers/imageUploadWorker.js",
      // cwd: 未设置，使用 PM2 启动目录
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "image-meta-worker-dev",
      script: "src/workers/imageMetaWorker.js",
      // cwd: 未设置，使用 PM2 启动目录
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "search-index-worker-dev",
      script: "src/workers/searchIndexWorker.js",
      // cwd: 未设置，使用 PM2 启动目录
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "cleanup-worker-dev",
      script: "src/workers/cleanupWorker.js",
      // cwd: 未设置，使用 PM2 启动目录
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "development",
      },
    },

    // ========== 定时任务 (开发版) ==========
    // {
    //   name: "cleanup-rebuild-all-dev",
    //   script: "scripts/development/rebuild-similar-groups.js",
    //   cwd: ".",
    //   // 定时执行：每天凌晨 3 点执行一次（开发环境可根据需要调整）
    //   // 如需测试，可以改为更频繁的时间，如 "0 */6 * * *" (每6小时) 或注释掉 cron 手动执行
    //   cron: "0 3 * * *",
    //   // 执行完成后自动退出，不常驻
    //   autorestart: false,
    //   watch: false,
    //   // 实例数：只运行一个实例
    //   instances: 1,
    //   // 执行模式：fork 模式（适合一次性脚本）
    //   exec_mode: "fork",
    //   env: {
    //     NODE_ENV: "development",
    //   },
    //   // 日志配置（如果 logs 目录不存在，PM2 会自动创建）
    //   error_file: "./logs/cleanup-rebuild-all-dev-error.log",
    //   out_file: "./logs/cleanup-rebuild-all-dev-out.log",
    //   log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    //   merge_logs: true,
    //   // 保留最近 10 天的日志
    //   log_file: "./logs/cleanup-rebuild-all-dev-combined.log",
    //   time: true,
    // },

    // ========== Python AI 服务 (开发版) ==========
    // {
    //   name: "python-ai-service-dev",
    //   script: "start.py",
    //   interpreter: "./python-ai-service/venv/bin/python",
    //   cwd: "./python-ai-service",
    //   watch: false,
    //   max_restarts: 5,
    //   env: {
    //   },
    // },
  ],
};

/*
🚀 使用说明:

📋 开发环境启动:
pm2 start ecosystem.dev.config.js

📋 本地开发 (如果需要指定 Python 路径):
export PYTHON_SERVICE_PATH="/System/Volumes/Data/Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service/python-face-service"
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
- 重启所有 Workers: pm2 restart image-upload-worker-dev image-meta-worker-dev search-index-worker-dev

📋 开发调试:
- 查看 API 日志: pm2 logs app-service-dev
- 查看 Python AI 日志: pm2 logs python-ai-service-dev
- 查看 Worker 日志: pm2 logs image-upload-worker-dev
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
