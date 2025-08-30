/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15
 * @Description: meta 阶段（EXIF + 高清产物 + DB 补充）的独立处理器
 */

const path = require("path");
const fsExtra = require("fs-extra");
const logger = require("../utils/logger");
const { extractImageMetadata, updateImageMetaAndHQ, formatSingleImage } = require("../services/imageService");
const { DateTime } = require("luxon");
const { stringToTimestamp } = require("../utils/formatTime");
const timeIt = require("../utils/timeIt");

// 用于存放被处理成功的图片源图的文件夹
const originalFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_ORIGINAL_IMAGE_DIR);
// 用于存放被处理成功的图片
const highResFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_HIGH_RES_IMAGE_DIR);

fsExtra.ensureDirSync(originalFolder);
fsExtra.ensureDirSync(highResFolder);

// 时区
const TIMEZONE = (process.env.TIMEZONE || "local").toLowerCase() === "utc" ? "utc" : "local";

const _toMonthKey = (ts) => {
  if (ts == null) return "unknown"; //ts为nulh或undefined
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy-MM") : "unknown";
};

const _toYearKey = (ts) => {
  if (ts == null) return "unknown";
  const dt = DateTime.fromMillis(Number(ts), { zone: TIMEZONE });
  return dt.isValid ? dt.toFormat("yyyy") : "unknown";
};

/**
 * 处理单张图片的“后处理”：
 * 1) 读取 EXIF → creationDate/monthKey/yearKey
 * 2) 产出高清大图（默认 AVIF）
 * 3) 更新数据库（补 creationDate/monthKey/yearKey/highResUrl）
 * 4) 将原图从uploadedFiles移动至originalFolder
 *
 * @param {Object} payload
 * @param {number|string} payload.userId
 * @param {string} payload.imageHash
 * @param {string} payload.sourcePath
 * @param {string} [payload.highResExt]
 */
async function processImageMeta(payload) {
  const { userId, imageHash, filename, sourcePath, highResExt } = payload;

  // 1) 解析 EXIF → creationDate
  let creationDate = null;
  try {
    const exif = await extractImageMetadata(sourcePath);
    creationDate = exif?.DateTimeOriginal ? stringToTimestamp(exif.DateTimeOriginal.rawValue) : null;
  } catch (e) {
    // 非致命：没 EXIF 也可以走 unknown
    logger.warn({
      message: "EXIF read failed in imageMetaIngestor",
      details: { imageHash, userId, err: String(e) },
    });
  }

  const monthKey = _toMonthKey(creationDate);
  const yearKey = _toYearKey(creationDate);

  // 2) 产出高清大图（AVIF 默认）
  // 直接使用上传时的文件名，只替换扩展名
  const baseName = path.basename(filename, path.extname(filename));
  const highResPath = path.join(highResFolder, `${baseName}.${highResExt}`);
  try {
    await timeIt(
      "metaformatSingleImage",
      async () => {
        await formatSingleImage({
          inputPath: sourcePath, // 用原图生成保证质量
          outputPath: highResPath,
          quality: 55, // 建议50-60
          resizeWidth: 2560, //
        });
      },
      imageHash,
    );
    // await formatSingleImage({
    //   inputPath: sourcePath, // 用原图生成保证质量
    //   outputPath: highResPath,
    //   quality: 55, // 可按需微调
    //  resizeWidth: 2560,
    // });
  } catch (e) {
    // 高清失败也不算致命 → 记录警告，继续更新元数据
    logger.warn({
      message: "Generate HQ image (AVIF) failed",
      details: { imageHash, userId, err: String(e) },
    });
  }

  // 3) 更新数据库：补 creationDate / monthKey / yearKey / highResUrl
  try {
    await updateImageMetaAndHQ({
      userId,
      hash: imageHash,
      creationDate,
      monthKey,
      yearKey,
      highResUrl: `/${process.env.PROCESSED_HIGH_RES_IMAGE_DIR}/${baseName}.${highResExt}`,
      originalUrl: `/${process.env.PROCESSED_ORIGINAL_IMAGE_DIR}/${filename}`,
    });
  } catch (e) {
    logger.error({
      message: "updateImageMetaAndHQ failed in imageMetaIngestor",
      details: { imageHash, userId, err: String(e) },
    });
    // 不删文件：留待后续修复脚本或人工巡检
  }
  // ======== 移动原图到 original 文件夹 ========
  const originalPath = path.join(originalFolder, filename);
  try {
    await fsExtra.move(sourcePath, originalPath, { overwrite: true });
  } catch (e) {
    // 记录错误，不算致命
    logger.warn({ message: "move original failed", details: { sourcePath, originalPath, err: String(e) } });
  }
}

module.exports = {
  processImageMeta,
};
