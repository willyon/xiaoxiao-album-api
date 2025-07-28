/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 14:06:00
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-07-25 16:55:56
 * @Description: File description
 */
const express = require("express");
const router = express.Router();
const { handleGetAllByPage, handleGetByTimeRange, handleGroupByYear, handleGroupByMonth } = require("../controllers/imageController");

// 分页获取图片信息
router.post("/queryAllByPage", handleGetAllByPage);
// 分页获取具体某个月份的图片信息
router.post("/queryByTimeRange", handleGetByTimeRange);
// 分页获取按年份分组数据
router.post("/queryGroupByYear", handleGroupByYear);
// 分页获取按月份分组数据
router.post("/queryGroupByMonth", handleGroupByMonth);

module.exports = router;
