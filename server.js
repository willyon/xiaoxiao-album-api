/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 16:46:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-12 15:53:02
 * @Description: Optimized Server Configuration
 */

// 加载.env文件中的环境变量
require("dotenv").config();
const path = require("path");

const express = require("express");
const { getRedisClient } = require("./src/services/redisClient");
const initGracefulShutdown = require("./src/utils/gracefulShutdown");

const { closeUploadQueue } = require("./src/queues/uploadQueue");

// 应用服务安全中间件
const xssClean = require("xss-clean");
const cookieParser = require("cookie-parser");
// const helmet = require("helmet");
// const rateLimit = require("express-rate-limit");

//中间件
const { responseHandler } = require("./src/middlewares/responseHandler");
const { errorHandler } = require("./src/middlewares/errorHandler");
const authMiddleware = require("./src/middlewares/authMiddleware");

// 导入业务路由
const authRoutes = require("./src/routes/authRoutes");
const imagesRoutes = require("./src/routes/imagesRoutes");

// ========================== 创建Express实例，设置端口号 ========================== //

const app = express();
const PORT = process.env.PORT || 3000;

// ========================== 安全中间件 ========================== //

// 提升Express应用安全性 通过设置http响应头来防止一些常见的网页安全攻击 如xss、点击劫持等
// app.use(helmet());
//允许图片、音频、视频等静态资源可以被别的网页通过 <img>、<video>、<audio>、<iframe> 等标签加载。
// app.use(helmet({ crossOriginResourcePolicy: false }));

// 防止xss攻击 自动过滤用户提交的数据里的恶意脚本。
app.use(xssClean());

// 限流防刷。每15分钟最多10000次请求。api接口 静态资源访问都算是 如访问加载一张图片算一次 这个限制暂时没必要加
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 10000,
// });
// app.use(limiter);

// ========================== 基础中间件 ========================== //

// 注册JSON请求体解析
app.use(express.json());

// 添加自动解析cookie的中间件
app.use(cookieParser());

// 注册表单解析 解析form-data或URL参数 { extended: true }表示使用第三方qs模块 以便解析嵌套对象
app.use(express.urlencoded({ extended: true }));

// 注册自定义响应格式中间件 必须在所有路由之前挂载
app.use(responseHandler);

// ========================== 静态资源中间件 ========================== //

// 提供静态文件访问服务
app.use("/processedFiles", express.static(path.join(__dirname, "processedFiles")));

// ========================== 业务路由注册 ========================== //

// 注册 注册/登录 路由
app.use("/auth", authRoutes);

// 注册图片业务路由+鉴权中间件(authMiddleware)
app.use("/images", [authMiddleware], imagesRoutes);

// ========================== 错误处理中间件 ========================== //

// 注册错误处理器 必须在所有路由之后挂载
app.use(errorHandler);

// ========================== 启动服务器 ========================== //

const server = app.listen(PORT, () => {
  console.log(`服务已启用：http://localhost:${PORT}`);
});

// 应用服务进程退出前进行的操作
initGracefulShutdown({
  server,
  getRedisClient,
  extraClosers: [
    // 关闭 BullMQ 的 Queue 及其底层连接（API 进程只负责入队）
    async () => closeUploadQueue(),
  ],
});
