/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 17:05:12
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-16 21:21:08
 * @Description: File description
 */
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "xiaoxiao-api",
      script: "server.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-upload-worker",
      script: "src/workers/imageUploadWorker.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "image-meta-worker",
      script: "src/workers/imageMetaWorker.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
