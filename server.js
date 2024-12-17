/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 16:46:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-17 02:24:03
 * @Description: File description
 */
// 服务器入口

require("dotenv").config();
const express = require("express");
const { getRedisClient } = require("./src/services/redisClient");
const app = express();
const PORT = 3000; // 端口号 自定义
const path = require("path");
// const {} = require("src/");

// 启动时连接 Redis
(async () => {
  await getRedisClient();
  console.log("Server is ready and Redis is connected!");
})();

// 服务器基本路径
// const SERVER_BASE_URL = "http://localhost:3000";

// 这段代码使得 processedFiles 目录中的文件可以通过 URL http://localhost:3000/processedFiles/... 来访问。
app.use("/processedFiles", express.static(path.join(__dirname, "processedFiles")));

// 设置express应用程序解析JSON请求体，这样就可以自动将请求体中的 JSON 数据解析成 JavaScript 对象，并将其挂载在 req.body 上
app.use(express.json());

// 引入路由
const authRoutes = require("./src/routes/userAuth"); // 加载auth路由
const imagesRoutes = require("./src/routes/images"); // 加载images路由
//使用路由 e.g. 接收post请求 /images/queryAllByPage
app.use("/auth", authRoutes);
app.use("/images", imagesRoutes);

// 关闭 Redis 连接（程序退出时） SIGINT:signal interrupt
process.on("SIGINT", async () => {
  try {
    console.log("Closing Redis connection...");
    const redisClient = await getRedisClient();
    if (redisClient) {
      await redisClient.quit();
      console.log("Redis connection closed successfully.");
    }
  } catch (error) {
    console.error("Failed to close Redis connection:", error);
  } finally {
    process.exit(0); // 在 finally 中确保进程退出
  }
});

app.listen(PORT, () => {
  console.log(`服务已启用：http://localhost:${PORT}`);
});
