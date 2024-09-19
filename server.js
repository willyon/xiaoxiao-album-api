/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 16:46:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-18 00:02:11
 * @Description: File description
 */
// 服务器入口

require("dotenv").config();
const express = require("express");
const app = express();
const port = 3000; // 端口号 自定义
const path = require("path");
// const {} = require("src/");

// 服务器基本路径
// const SERVER_BASE_URL = "http://localhost:3000";

// 这段代码使得 processedFiles 目录中的文件可以通过 URL http://localhost:3000/processedFiles/... 来访问。
app.use("/processedFiles", express.static(path.join(__dirname, "processedFiles")));

// 设置express应用程序解析JSON请求体，这样就可以自动将请求体中的 JSON 数据解析成 JavaScript 对象，并将其挂载在 req.body 上
app.use(express.json());

// 引入路由
const imagesRouter = require("./src/routes/images");

//使用路由
app.use("/images", imagesRouter);

app.listen(port, () => {
  console.log(`服务已启用：http://localhost:${port}`);
});
