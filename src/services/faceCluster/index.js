/**
 * 人脸聚类子模块聚合入口：统一导出编排层、调度层、缩略图层与模型直通能力。
 */
const {
  getFaceEmbeddingIdsByClusterId,
  getClustersByUserId,
  getClusterCardByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdByMediaIdInCluster
} = require('../../models/faceClusterModel')
const {
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  revokePreviousManualCoverAssets,
  ensureClusterCoverAfterMove
} = require('./faceClusterThumbnailPipeline')
const { scheduleUserClustering } = require('./faceClusterScheduler')
const { attachClusterCoverUrls } = require('./attachClusterCoverUrls')

module.exports = {
  scheduleUserClustering,
  attachClusterCoverUrls,
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  revokePreviousManualCoverAssets,
  ensureClusterCoverAfterMove,
  getFaceEmbeddingIdsByClusterId,
  getClustersByUserId,
  getClusterCardByUserId,
  getRecentClustersByUserId,
  getExistingPersonNames,
  updateClusterName,
  moveFacesToCluster,
  setClusterCover,
  verifyFaceEmbeddingInCluster,
  getFaceEmbeddingIdByMediaIdInCluster
}
