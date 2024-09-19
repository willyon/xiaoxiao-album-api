/*
 * @Author: zhangshouchang
 * @Date: 2024-09-06 13:31:52
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-06 13:50:09
 * @Description: File description
 */
const fs = require("fs");

// 日志文件目录
// const logFile = path.join(__dirname, "..", "..", process.env.PROCESSED_IMAGE_LOG_FILE);

// 创建日志流 a表示 新内容是在原来内容基础新增 而不是覆盖
// const logStream = fs.createWriteStream(logFile, { flags: "a" });

const logError = (message) => {
  console.error(message);
  logStream.write(message + "\n");
};

module.exports = {
  logError,
};
