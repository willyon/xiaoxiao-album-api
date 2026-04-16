/*
 * 主链媒体分析（mediaAnalysisIngestor）：Worker 仅通过本模块访问 model，不直调 mediaModel / mediaAnalysisModel / mediaEmbeddingModel。
 */
const mediaModel = require('../models/mediaModel')

module.exports = {
  insertFaceEmbeddings: mediaModel.insertFaceEmbeddings,
  normalizeTextArray: mediaModel.normalizeTextArray,
  updateAnalysisStatusPrimary: mediaModel.updateAnalysisStatusPrimary,
  finalizeMediaAnalysis: mediaModel.finalizeMediaAnalysis,
  upsertMediaEmbedding: mediaModel.upsertMediaEmbedding
}
