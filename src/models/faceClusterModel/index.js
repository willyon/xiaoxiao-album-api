/**
 * 人脸聚类模型聚合入口：统一导出归属校验、批量写入、代表向量与封面、迁移恢复、列表与统计查询、
 * 人脸缩略图与清晰度、人物改名与移脸等能力（对外 API 与原先单文件 faceClusterModel 的 module.exports 一致）。
 */
module.exports = {
  ...require('./faceClusterVerification'),
  ...require('./faceClusterBulk'),
  ...require('./faceClusterRepresentative'),
  ...require('./faceClusterMigration'),
  ...require('./faceClusterQuery'),
  ...require('./faceEmbeddingThumbnail'),
  ...require('./faceClusterMutation'),
}
