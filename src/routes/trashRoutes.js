/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 回收站路由
 */

const express = require("express");
const router = express.Router();
const {
  handleGetTrashSummary,
  handleGetDeletedImages,
  handleRestoreImages,
  handlePermanentlyDeleteImages,
  handleClearTrash,
} = require("../controllers/trashController");

// 获取回收站统计信息
router.get("/summary", handleGetTrashSummary);

// 分页获取已删除图片列表
router.get("/", handleGetDeletedImages);

// 批量恢复图片
router.post("/restore", handleRestoreImages);

// 批量永久删除图片
router.delete("/", handlePermanentlyDeleteImages);

// 清空回收站
router.delete("/all", handleClearTrash);

module.exports = router;
