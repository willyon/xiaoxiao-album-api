/**
 * 人脸聚类子模块聚合入口：统一导出编排层、调度层、缩略图层与模型直通能力。
 */
const {
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
const {
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  revokePreviousManualCoverAssets
} = require('./faceClusterThumbnailPipeline')
const { scheduleUserClustering } = require('./faceClusterScheduler')
const { attachClusterCoverUrls } = require('./attachClusterCoverUrls')

module.exports = {
  scheduleUserClustering,
  attachClusterCoverUrls,
  restoreDefaultCover,
  generateThumbnailForFaceEmbedding,
  revokePreviousManualCoverAssets,
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
