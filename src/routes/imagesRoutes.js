/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-14 00:54:38
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload"); // 引入 upload 中间件
const {
  handleGetAllByPage,
  handleGetByCertainYear,
  handleGetByCertainMonth,
  handleGroupByYear,
  handleGroupByMonth,
  handleCheckFileExists,
} = require("../controllers/imageController");
const { handlePostImages } = require("../controllers/uploadController");
const { handleGetUploadSignature } = require("../controllers/ossUploadController");

//上传图片
router.post("/postImages", upload, handlePostImages);

// 预检和直传相关路由
router.post("/checkFileExists", handleCheckFileExists);
router.post("/getUploadSignature", handleGetUploadSignature);

// 分页获取图片信息
router.post("/queryAllByPage", handleGetAllByPage);
// 分页获取按年份分组数据
router.post("/queryGroupByYear", handleGroupByYear);
// 分页获取按月份分组数据
router.post("/queryGroupByMonth", handleGroupByMonth);
// 分页获取具体某个年份的图片信息
router.post("/queryByCertainYear", handleGetByCertainYear);
// 分页获取具体某个月份的图片信息
router.post("/queryByCertainMonth", handleGetByCertainMonth);

module.exports = router;
