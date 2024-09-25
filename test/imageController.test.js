/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 15:05:27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-25 16:06:54
 * @Description: File description
 */
//  processAndSaveImage
const { processAndSaveImage } = require("../src/controllers/imageController");
const { sqlTest } = require("../src/models/imageModel");

processAndSaveImage();
// sqlTest();

// describe("Image Controller", () => {
//   it("process and save new image", () => {
//   });
// });
