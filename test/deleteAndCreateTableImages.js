/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 15:05:27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-27 14:47:20
 * @Description: File description
 */
//  processAndSaveImage
const { deleteTableImages, createTableImages } = require("../src/models/imageModel");

// 删表
deleteTableImages();
// 建表
createTableImages();

// describe("Image Controller", () => {
//   it("process and save new image", () => {
//   });
// });
