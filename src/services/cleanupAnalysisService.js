const axios = require("axios");
const cleanupModel = require("../models/cleanupModel");
const { upsertMediaEmbedding, getMediaEmbedding } = require("../models/mediaEmbeddingModel");
const { scheduleUserRebuild } = require("../services/cleanupGroupingScheduler");
const { withAiSlot } = require("./aiConcurrencyLimiter");

const PYTHON_SERVICE_URL =
  process.env.PYTHON_CLEANUP_SERVICE_URL || process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

const { FormData, Blob } = globalThis;

async function runCleanupAnalysisCore({ imageId, userId, buffer }) {
  const existingEmbedding = getMediaEmbedding(imageId);

  if (!buffer) {
    return {
      ok: false,
      errorCode: "CLEANUP_IMAGE_BUFFER_MISSING",
      analysis: null,
      embeddingFailed: false,
    };
  }

  const formData = new FormData();
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: "application/octet-stream" });
  formData.append("image", blob, `image-${imageId}.bin`);

  if (existingEmbedding && existingEmbedding.vector && Array.isArray(existingEmbedding.vector)) {
    formData.append("skip_embedding", "true");
    formData.append("existing_embedding", JSON.stringify(existingEmbedding.vector));
    formData.append("embedding_model", existingEmbedding.modelId || "siglip2");
  }

  const profile = process.env.AI_ANALYSIS_PROFILE || "basic";
  const device = process.env.AI_DEVICE || "auto";
  formData.append("profile", profile);
  formData.append("device", device);

  const response = await withAiSlot(() =>
    axios.post(`${PYTHON_SERVICE_URL}/analyze_cleanup`, formData, {
      timeout: Number(process.env.CLEANUP_ANALYSIS_TIMEOUT || 300000),
      maxBodyLength: Infinity,
      headers: typeof formData.getHeaders === "function" ? formData.getHeaders() : undefined,
    }),
  );

  const analysis = response.data || {};

  const round2 = (v) => (typeof v === "number" ? Number(v.toFixed(2)) : null);

  cleanupModel.updateMediaCleanupMetrics(imageId, {
    imagePhash: analysis?.hashes?.phash ?? null,
    imageDhash: analysis?.hashes?.dhash ?? null,
    aestheticScore: round2(analysis.aesthetic_score ?? null),
    sharpnessScore: round2(analysis.sharpness_score ?? null),
  });

  const embeddingVec = Array.isArray(analysis?.embedding?.vector) ? analysis.embedding.vector : null;
  const embeddingModel = analysis?.embedding?.model || "siglip2";
  let embeddingFailed = false;
  if (embeddingVec && embeddingVec.length) {
    try {
      upsertMediaEmbedding({ imageId, vector: embeddingVec, modelId: embeddingModel });
    } catch (e) {
      embeddingFailed = true;
    }
  }

  scheduleUserRebuild(userId);

  return {
    ok: true,
    errorCode: null,
    analysis,
    embeddingFailed,
    embeddingModel,
  };
}

module.exports = {
  runCleanupAnalysisCore,
};

