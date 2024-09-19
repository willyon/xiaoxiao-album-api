/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-18 22:40:23
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const imageController = require("../controllers/imageController");

// 获取所有图片信息
router.get("/queryAll", imageController.getAllImages);
// 分页获取图片信息
router.post("/queryAllByPage", imageController.getAllImagesByPage);
// 分页获取具体某个月份的图片信息
router.post("/queryCertainMonthByPage", imageController.getCertainMonthImagesByPage);

module.exports = router;
