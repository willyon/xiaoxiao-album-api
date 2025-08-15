/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const path = require("path");
const fsExtra = require("fs-extra");
const { DateTime } = require("luxon");
const logger = require("../utils/logger");
const imageService = require("../services/imageService");
const { stringToTimestamp } = require("../utils/formatTime");
// 存放处理成功图片的源图片文件夹
const originalFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR);
// 转换高质量大图目录
const bigHighImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_HIGH_IMAGE_DIR);

fsExtra.ensureDirSync(originalFolder);
fsExtra.ensureDirSync(bigHighImageFolder);

// 时区（与主流程保持一致）
const TIMEZONE = (process.env.TIMEZONE || "local").toLowerCase() === "utc" ? "utc" : "local";

const toMonthKey = (ts) => {
  if (ts == null) return "unknown";
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy-LL") : "unknown";
};

const toYearKey = (ts) => {
  if (ts == null) return "unknown";
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy") : "unknown";
};

/**
 * 处理单张图片的“后处理”：
 * 1) 读取 EXIF → creationDate/monthKey/yearKey
 * 2) 产出高清大图（默认 AVIF）
 * 3) 更新数据库（补 creationDate/monthKey/yearKey/bigHighQualityImageUrl）
 *
 * @param {Object} payload
 * @param {number|string} payload.userId
 * @param {string} payload.imageHash
 * @param {string} payload.sourceFilePath  // 建议传 original 路径
 * @param {string} [payload.bigHighExt]    // 默认取 env 或 'avif'
 */
async function processImageMeta(payload) {
  const { userId, imageHash, filename, sourceFilePath, bigHighExt } = payload;

  // 1) 解析 EXIF → creationDate
  let creationDate = null;
  try {
    const exif = await imageService.extractImageMetadata(sourceFilePath);
    creationDate = exif?.DateTimeOriginal ? stringToTimestamp(exif.DateTimeOriginal.rawValue) : null;
  } catch (e) {
    // 非致命：没 EXIF 也可以走 unknown
    logger.warn({
      message: "EXIF read failed in metaIngestor",
      details: { imageHash, userId, err: String(e) },
    });
  }

  const monthKey = toMonthKey(creationDate);
  const yearKey = toYearKey(creationDate);

  // 2) 产出高清大图（AVIF 默认）
  const bigHighPath = path.join(bigHighImageFolder, `${imageHash}.${bigHighExt}`);
  try {
    await imageService.formatSingleImage({
      inputPath: sourceFilePath, // 用原图生成保证质量
      outputPath: bigHighPath,
      quality: 85, // 可按需微调
    });
  } catch (e) {
    // 高清失败也不算致命 → 记录警告，继续更新元数据
    logger.warn({
      message: "Generate HQ image (AVIF) failed",
      details: { imageHash, userId, err: String(e) },
    });
  }

  // 3) 更新数据库：补 creationDate / monthKey / yearKey / bigHighQualityImageUrl
  try {
    await imageService.updateImageMetaAndHQ({
      userId,
      hash: imageHash,
      creationDate,
      monthKey,
      yearKey,
      bigHighQualityImageUrl: `/${process.env.PROCESSED_BIG_HIGH_IMAGE_DIR}/${imageHash}.${bigHighExt}`,
      originalImageUrl: `/${process.env.PROCESSED_ORIGINAL_IMAGE_DIR}/${filename}`,
    });
  } catch (e) {
    logger.error({
      message: "updateImageMetaAndHQ failed in metaIngestor",
      details: { imageHash, userId, err: String(e) },
    });
    // 不删文件：留待后续修复脚本或人工巡检
  }
  // ======== 移动原图到 original 文件夹 ========
  const originalFilePath = path.join(originalFolder, filename);
  try {
    await fsExtra.move(sourceFilePath, originalFilePath, { overwrite: true });
  } catch (e) {
    // 记录错误，不算致命
    logger.warn({ message: "move original failed", details: { sourceFilePath, originalFilePath, err: String(e) } });
  }
}

module.exports = {
  processImageMeta,
};
