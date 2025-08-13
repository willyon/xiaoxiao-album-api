/*
 * @Author: zhangshouchang
 * @Date: 2025-08-04 17:05:12
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 17:05:24
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
      name: "upload-worker",
      script: "src/workers/uploadWorker.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
