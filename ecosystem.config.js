/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 完整服务 PM2 配置 - 生产环境
 *
 * 🚀 包含服务:
 * • Node.js API 服务
 * • Node.js Workers (图片上传、元数据处理、搜索索引)
 * • Python AI 服务 (人脸识别、OCR等)
 */
module.exports = {
  apps: [
    // ========== Node.js 服务 ==========
    {
      name: "app-service",
      script: "server.js",
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-upload-worker",
      script: "src/workers/imageUploadWorker.js",
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-meta-worker",
      script: "src/workers/imageMetaWorker.js",
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "search-index-worker",
      script: "src/workers/searchIndexWorker.js",
      // cwd: "/var/www/photos.bingbingcloud.com/backend", // 绝对路径
      cwd: ".", // 相对路径
      watch: false,
      max_restarts: 5,
      env: {
        NODE_ENV: "production",
      },
    },

    // ========== Python AI 服务 ==========
    // {
    //   name: "python-ai-service",
    //   script: "start.py",
    //   interpreter: "./python-ai-service/venv/bin/python",
    //   cwd: "./python-ai-service",
    //   watch: false,
    //   max_restarts: 5,
    //   env: {
    //     // 其他环境变量从 .env 文件读取
    //   },
    // },
  ],
};

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
- 重启所有 Workers: pm2 restart image-upload-worker image-meta-worker search-index-worker

📋 监控命令:
- 实时监控: pm2 monit
- 查看进程信息: pm2 show app-service
- 查看错误日志: pm2 logs --err
*/
