/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 17:05:12
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-20 08:17:53
 * @Description: File description
 */
// ecosystem.config.js
// 开发环境配置 主要用于开发环境测试 pm2 start ecosystem.dev.config.js
module.exports = {
  apps: [
    {
      name: "app-service",
      script: "server.js",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "image-upload-worker",
      script: "src/workers/imageUploadWorker.js",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "image-meta-worker",
      script: "src/workers/imageMetaWorker.js",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
