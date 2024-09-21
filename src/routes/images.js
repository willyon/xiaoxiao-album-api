/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-22 02:57:30
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
router.post("/queryCertainTimeRangeByPage", imageController.getCertainTimeRangeImagesByPage);
// 分页获取按年份分组数据
router.post("/queryGroupByYearAndPage", imageController.getGroupedImagesByYearAndPage);
// 分页获取按月份分组数据
router.post("/queryGroupByMonthAndPage", imageController.getGroupedImagesByMonthAndPage);

module.exports = router;
