/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-29 21:44:42
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const imageController = require("../controllers/imageController");

// 分页获取图片信息
router.post("/queryAllByPage", imageController.handleGetAllByPage);
// 分页获取具体某个月份的图片信息
router.post("/queryByTimeRange", imageController.handleGetByTimeRange);
// 分页获取按年份分组数据
router.post("/queryGroupByYear", imageController.handleGroupByYear);
// 分页获取按月份分组数据
router.post("/queryGroupByMonth", imageController.handleGroupByMonth);

module.exports = router;
