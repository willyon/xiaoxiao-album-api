/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 16:46:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-31 00:58:21
 * @Description: File description
 */
// 服务器入口

const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const app = express();
const port = 3000; // 端口号 自定义

// 服务器基本路径
// const SERVER_BASE_URL = "http://localhost:3000";

// 这段代码使得 convertImage 目录中的文件可以通过 URL http://localhost:3000/convertImage/... 来访问。
app.use("/convertImage", express.static(path.join(__dirname, "convertImage")));

// 连接数据库
const db = new Database("database.db");

// 设置express应用程序解析JSON请求体，这样就可以自动将请求体中的 JSON 数据解析成 JavaScript 对象，并将其挂载在 req.body 上
app.use(express.json());

// 定义获取图片信息的api路由
app.get("/images/query", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    // 查询数据库
    // 用于创建一个准备好的 SQL 语句，这可以提高查询效率，尤其是在执行多个相似的查询时。
    const stmt = db.prepare("SELECT * FROM images");
    // 这个准备好的语句可以通过 stmt.all()、stmt.get() 或 stmt.run() 方法执行，分别用于获取所有记录、获取单条记录或执行修改操作 stmt.all()返回的是一个对象数组
    const images = stmt.all();
    // 将 imagesWithBaseUrl 数组转换成 JSON 格式，并将其发送给客户端
    // res.json(images);

    // 为每张图片添加服务器基本路径
    const imagesWithBaseUrl = images.map((image) => {
      return {
        ...image,
        bigPath: `${baseUrl}${image.bigPath}`,
        smallPath: `${baseUrl}${image.smallPath}`,
      };
    });
    res.json(imagesWithBaseUrl);
  } catch (err) {
    console.log("查询图片信息表出错：", err);
    res.status(500).json({ error: "internal server error" });
  }
});

app.listen(port, () => {
  console.log(`服务已启用：http://localhost:${port}`);
});
