/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 17:05:12
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-20 08:17:53
 * @Description: File description
 */
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "xiaoxiao-api",
      script: "server.js",
      cwd: "/var/www/xiaoxiao-album/backend",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-upload-worker",
      script: "src/workers/imageUploadWorker.js",
      cwd: "/var/www/xiaoxiao-album/backend",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-meta-worker",
      script: "src/workers/imageMetaWorker.js",
      cwd: "/var/www/xiaoxiao-album/backend",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
