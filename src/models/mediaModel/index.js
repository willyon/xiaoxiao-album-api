/**
 * 媒体模型聚合入口：统一导出媒体写入、时间轴查询、分析状态、失败队列与向量能力。
 */
const { sqlLocationKeyNullable, sqlLocationIsUnknown, normalizeTextArray } = require("./mediaLocationSql");
const {
  selectMediasByYear,
  selectMediasByMonth,
  selectMediasByDate,
} = require("./mediaTimelineItems");
const {
  getMediasByBlurry,
  updateBlurryForUser,
  selectGroupsByCity,
  selectMediasByCity,
} = require("./mediaCityAndBlurry");
const {
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
} = require("./mediaTimelineGroups");
const { getMediaStorageInfo, getMediaExportInfo, getMediasExportInfo } = require('./mediaExportAndStorage')
const {
  updateAnalysisStatusPrimary,
  updateAnalysisStatusCloud,
  updateMapRegeoStatus,
  upsertMediaAiFieldsForAnalysis,
  insertFaceEmbeddings,
} = require("./mediaAnalysisPipeline");
const {
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage,
  selectPendingCloudCaptionBatch,
  countCloudAnalysisSkippedForUser,
  countMapRegeoSkippedForUser,
  selectPendingMapRegeoBatch,
  selectMediaRowForMapRegeoJob,
} = require("./mediaFailureAndQueues");
const { updateMediaMetadata, updateLocationInfo, updateMetaPipelineStatusByHash } = require("./mediaMetadataWrite");
const { rebuildMediaSearchDoc } = require("./mediaSearchDocument");
const { insertMedia, selectHashesByUserId, selectMediaRowByHashForUser } = require("./mediaInsertAndHash");
const { finalizeMediaAnalysis } = require("./mediaAnalysisModel");
const {
  listMediaSearchResults,
  countMediaSearchResults,
  recallMediaIdsByFts,
  recallMediaIdsByFiltersOnly,
  recallMediaIdsByOcrTextLike,
  recallMediaIdsByChineseTerms,
  countMediaIdsByChineseTerms,
  getFilterOptionsPaginated,
  getMediasByIds,
} = require("./mediaSearchModel");
const {
  MEDIA_EMBEDDING_SOURCE_TYPES,
  upsertMediaEmbeddingBySourceType,
  upsertMediaEmbedding,
  deleteMediaEmbeddingBySourceType,
  listVisualTextEmbeddingRowsForRecall,
} = require("./mediaEmbeddingModel");

module.exports = {
  sqlLocationKeyNullable,
  sqlLocationIsUnknown,
  normalizeTextArray,
  selectMediaRowByHashForUser,
  insertMedia,
  updateMediaMetadata,
  updateLocationInfo,
  insertFaceEmbeddings,
  selectMediasByYear,
  selectMediasByMonth,
  selectMediasByDate,
  getMediasByBlurry,
  updateBlurryForUser,
  selectGroupsByYear,
  selectGroupsByMonth,
  selectGroupsByDate,
  selectGroupsByCity,
  selectMediasByCity,
  selectHashesByUserId,
  getMediaStorageInfo,
  getMediaExportInfo,
  getMediasExportInfo,
  rebuildMediaSearchDoc,
  updateMetaPipelineStatusByHash,
  upsertMediaAiFieldsForAnalysis,
  updateAnalysisStatusPrimary,
  updateAnalysisStatusCloud,
  updateMapRegeoStatus,
  listFailedMedias,
  listAllFailedCloudMedias,
  countFailedMediasByStage,
  selectPendingCloudCaptionBatch,
  countCloudAnalysisSkippedForUser,
  countMapRegeoSkippedForUser,
  selectPendingMapRegeoBatch,
  selectMediaRowForMapRegeoJob,
  finalizeMediaAnalysis,
  listMediaSearchResults,
  countMediaSearchResults,
  recallMediaIdsByFts,
  recallMediaIdsByFiltersOnly,
  recallMediaIdsByOcrTextLike,
  recallMediaIdsByChineseTerms,
  countMediaIdsByChineseTerms,
  getFilterOptionsPaginated,
  getMediasByIds,
  MEDIA_EMBEDDING_SOURCE_TYPES,
  upsertMediaEmbeddingBySourceType,
  upsertMediaEmbedding,
  deleteMediaEmbeddingBySourceType,
  listVisualTextEmbeddingRowsForRecall,
};
