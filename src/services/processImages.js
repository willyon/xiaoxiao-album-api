/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 13:09:08
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-31 00:40:27
 * @Description: File description
 */
// require("dotenv").config();
// const fsExtra = require("fs-extra");
// const fs = require("fs/promises");
// const path = require("path");
const { imageFormat } = require("../utils/imageFormatter");
const { getImageMetadata } = require("../utils/imageMetadataExtraction");
const db = require("../utils/db");

// db.exec("DROP TABLE images");

// 格式化图片 获取图片元数据 将图片相关信息写入数据表
imageFormat()
  .then(() => {
    return getImageMetadata();
  })
  .then((imageMessages) => {
    console.log("图片信息:", imageMessages);
    imageMessages.forEach((message) => {
      insertImageInfo(message);
    });
  });

// 测试 仅读取元数据
// getImageMetadata().then((imageMessages) => {
//   console.log("图片信息:", imageMessages);
//   imageMessages.forEach((message) => {
//     insertImageInfo(message);
//   });
// });

const insertImageInfo = ({ bigPath, smallPath, creationDate }) => {
  const stmt = db.prepare(`
    INSERT INTO images (bigPath, smallPath,creationDate)
    VALUES (?, ?, ?)
  `);

  stmt.run(bigPath, smallPath, creationDate);
};
