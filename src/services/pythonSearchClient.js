/*
 * @Author: zhangshouchang
 * @Date: 2025-01-28
 * @Description: Python AI 服务搜索客户端（文本编码 + 向量搜索）
 */

const axios = require("axios");
const logger = require("../utils/logger");
const { withAiSlot } = require("./aiConcurrencyLimiter");

const PYTHON_SERVICE_URL = process.env.PYTHON_FACE_SERVICE_URL || "http://localhost:5001";

/**
 * 将文本编码为向量
 * @param {string} text - 要编码的文本
 * @returns {Promise<{vector: number[], model: string}>} 向量和模型信息
 */
async function encodeText(text) {
  try {
    const profile = process.env.AI_ANALYSIS_PROFILE || "standard";
    const device = process.env.AI_DEVICE || "auto";
    const response = await withAiSlot(() =>
      axios.post(
        `${PYTHON_SERVICE_URL}/encode_text`,
        {
          text,
          profile,
          device,
        },
        {
          timeout: 10000, // 10秒超时
        },
      ),
    );

    return {
      vector: response.data.vector,
      model: response.data.model || "siglip2",
    };
  } catch (error) {
    logger.error({
      message: "文本编码失败",
      details: {
        error: error.message,
        text: text?.substring(0, 50),
        serviceUrl: PYTHON_SERVICE_URL,
      },
    });
    throw error;
  }
}

/**
 * 基于 ANN 索引的向量搜索
 * @param {number} userId - 用户ID
 * @param {number[]} queryVector - 查询向量（1152 维）
 * @param {number} topK - 返回前 k 个结果（默认 50）
 * @returns {Promise<Array<{media_id: number, score: number}>>} 搜索结果列表
 */
async function annSearchByVector(userId, queryVector, topK = 50) {
  try {
    const profile = process.env.AI_ANALYSIS_PROFILE || "standard";
    const device = process.env.AI_DEVICE || "auto";
    const response = await withAiSlot(() =>
      axios.post(
        `${PYTHON_SERVICE_URL}/ann_search_by_vector`,
        {
          user_id: userId,
          query_vector: queryVector,
          top_k: topK,
          profile,
          device,
        },
        {
          timeout: 15000,
        },
      ),
    );

    return response.data.results || [];
  } catch (error) {
    logger.error({
      message: "ANN 向量搜索失败",
      details: {
        error: error.message,
        serviceUrl: PYTHON_SERVICE_URL,
      },
    });
    throw error;
  }
}

module.exports = {
  encodeText,
  annSearchByVector,
};
