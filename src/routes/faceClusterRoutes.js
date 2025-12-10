/*
 * @Author: zhangshouchang
 * @Date: 2025-01-27
 * @Description: 人脸聚类路由
 */

const express = require("express");
const router = express.Router();
const {
  getClusterStats,
  getClusters,
  updateCluster,
  removeFaces,
  moveFaces,
  getClusterYearAlbums,
  getClusterMonthAlbums,
  setClusterCoverImage,
  restoreClusterCoverImage,
} = require("../controllers/faceClusterController");

// 获取聚类统计信息
router.get("/stats", getClusterStats);

// 获取用户的聚类列表（带分页）
router.get("/", getClusters);

// 获取指定人物的年份相册列表（必须在 /:clusterId 之前）
router.get("/:clusterId/albums/year", getClusterYearAlbums);

// 获取指定人物的月份相册列表（必须在 /:clusterId 之前）
router.get("/:clusterId/albums/month", getClusterMonthAlbums);

// 设置人物聚类封面（必须在 /:clusterId 之前）
router.patch("/:clusterId/cover", setClusterCoverImage);

// 恢复人物聚类默认封面（必须在 /:clusterId 之前）
router.delete("/:clusterId/cover", restoreClusterCoverImage);

// 从聚类中移除照片
router.delete("/:clusterId/faces", removeFaces);

// 将照片从一个聚类移动到另一个聚类（或创建新聚类）
router.post("/:clusterId/move-faces", moveFaces);

// 更新聚类名称
router.patch("/:clusterId", updateCluster);

module.exports = router;
