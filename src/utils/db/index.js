const fs = require("fs");
const path = require("path");

module.exports = function (db) {
  // 获取当前文件夹下的所有文件
  const files = fs.readdirSync(__dirname);

  // 遍历每个文件
  files.forEach((file) => {
    // 忽略index.js自己 且为 .js 文件
    if (file !== "index.js" && path.extname(file) === ".js") {
      require(path.join(__dirname, file))(db);
    }
  });
};
