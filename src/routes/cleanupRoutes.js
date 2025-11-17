const express = require("express");
const router = express.Router();
const { handleGetSummary, handleGetGroups, handleDeleteImages } = require("../controllers/cleanupController");

router.get("/summary", handleGetSummary);
router.get("/groups", handleGetGroups);
// 删除清理分组中的图片
router.post("/delete", handleDeleteImages);

module.exports = router;
