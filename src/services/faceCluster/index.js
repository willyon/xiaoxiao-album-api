/**
 * 人脸聚类子模块聚合入口：统一导出编排层、调度层、缩略图层与模型直通能力。
 */
const {
  getClusterStatsByUserId,
  getFaceEmbeddingIdsByClusterId,
  getClustersByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdByMediaIdInCluster
} = require('../../models/faceClusterModel')
const { performFaceClustering } = require('./faceClusteringOrchestrator')
const { restoreDefaultCover, generateThumbnailForFaceEmbedding } = require('./faceClusterThumbnailPipeline')
const { scheduleUserClustering } = require('./faceClusterScheduler')

module.exports = {
  performFaceClustering,
  scheduleUserClustering,
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  getClusterStatsByUserId,
  getFaceEmbeddingIdsByClusterId,
  getClustersByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdByMediaIdInCluster
}
