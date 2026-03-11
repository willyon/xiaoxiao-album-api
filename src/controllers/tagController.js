/*
 * 标签相关 API 控制器
 */

const { SUCCESS_CODES, ERROR_CODES } = require("../constants/messageCodes");
const tagStatisticsModel = require("../models/tagStatisticsModel");

/**
 * 获取热门标签
 * GET /api/tags/popular?type=object|scene|keyword&limit=20
 */
async function handleGetPopularTags(req, res, next) {
  try {
    const { type = "object", limit = "20" } = req.query || {};
    const allowedTypes = new Set(["object", "scene", "keyword"]);
    const tagType = String(type);
    if (!allowedTypes.has(tagType)) {
      return res.fail(ERROR_CODES.INVALID_PARAMETERS, "unsupported tag type");
    }
    const n = Number(limit) > 0 && Number(limit) <= 200 ? Number(limit) : 20;
    const rows = tagStatisticsModel.getPopularTags({ tagType, limit: n });
    return res.success(SUCCESS_CODES.REQUEST_COMPLETED, {
      type: tagType,
      list: rows.map((r) => ({ name: r.tag_name, count: r.count, lastUpdated: r.last_updated })),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  handleGetPopularTags,
};

