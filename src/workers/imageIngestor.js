/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require("../utils/logger");
const path = require("path");
const fsExtra = require("fs-extra");
const { saveNewImage, rollbackMany, formatMultipleImagesFromOneSource } = require("../services/imageService");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("../workers/sharedEnsure");
const { metaQueue } = require("../queues/metaQueue");

// 失败图片存放目录（防止失败文件滞留待处理目录）
const failedFolder = path.join(__dirname, "..", "..", process.env.FAILED_IMAGE_DIR);
// 重复图片存放目录
const duplicateFolder = path.join(__dirname, "..", "..", process.env.DUPLICATE_IMAGE_DIR);
// 转换低质量大图目录
const bigLowImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_BIG_LOW_IMAGE_DIR);
// 转换小图目录
const previewImageFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_PREVIEW_IMAGE_DIR);

// 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(failedFolder);
fsExtra.ensureDirSync(duplicateFolder);
fsExtra.ensureDirSync(bigLowImageFolder);
fsExtra.ensureDirSync(previewImageFolder);

// 迁移重复图片到duplicateFolder
async function handleDuplicatedImage(fileInfo) {
  const { filename, path: sourceFilePath } = fileInfo;
  const duplicateFilePath = path.join(duplicateFolder, filename);
  try {
    await fsExtra.move(sourceFilePath, duplicateFilePath, { overwrite: true });
  } catch (error) {
    logger.error({
      message: `move duplicated file failed: ${error?.message}`,
      stack: error?.stack,
      details: { step: "move duplicated file", file: sourceFilePath, duplicateFilePath },
    });
  }
}

// 原子化：先查集合 → 抢锁 → 失败则再查集合 → 再决定 busy/重复
async function ensureProcessRightOrShortCircuit(fileInfo, redisClient) {
  const { userId, imageHash } = fileInfo;
  const setKey = userSetKey(userId);

  // 1) 快路径：集合命中，立即按重复处理
  const already = await redisClient.sismember(setKey, imageHash);
  if (already === 1) {
    await handleDuplicatedImage(fileInfo);
    return { proceed: false }; // 不继续处理
  }

  // 2) 抢占锁（避免同图并发重复处理）
  const lockKey = `${process.env.IMAGES_HASH_LOCK_KEY_PREFIX}${imageHash}`;
  const ttlMs = Number(process.env.IMAGE_HASH_LOCK_TTL_MS) || 10 * 60 * 1000; //10分钟后释放锁 避免因为忘记释放锁导致死锁
  //NX：仅当 key 不存在 时才设置（Not eXists） PX <ms>：给这个 key 设置 过期时间（毫秒）（eXPIRE in ms）
  const lockOk = await redisClient.set(lockKey, "1", "NX", "PX", ttlMs);
  if (!lockOk) {
    // 3) 抢锁失败：复查集合（可能另一 worker 已经完成并写入）
    const nowExists = await redisClient.sismember(setKey, imageHash);
    if (nowExists === 1) {
      await handleDuplicatedImage(fileInfo);
      return { proceed: false };
    }
    // 仍不存在：说明别人正在处理，抛“忙”让队列重试
    const busyErr = new Error("image_processing_in_progress");
    busyErr.code = "IMG_BUSY";
    throw busyErr;
  }

  // 抢锁成功：把锁 key 返回给调用者以便 finally 里释放
  return { proceed: true, lockKey };
}

/**
 * 独立的单张图片处理与入库方法
 * @param {Object} fileInfo - 包含图片文件信息的对象，需至少有 filename、path、userId 字段
 */

async function processAndSaveSingleImage(fileInfo) {
  const { filename, path: sourceFilePath, userId, imageHash } = fileInfo;
  const redisClient = getRedisClient();
  let lockKey;

  try {
    const { proceed, lockKey: key } = await ensureProcessRightOrShortCircuit(fileInfo, redisClient);
    if (!proceed) return;
    lockKey = key;

    // ======== 快路径：仅产出 preview.webp + bigLow.webp ========
    const imgExtension = process.env.IMAGE_EXTENSION_WEBP || "webp";
    const bigLowPath = path.join(bigLowImageFolder, `${imageHash}.${imgExtension}`);
    const previewPath = path.join(previewImageFolder, `${imageHash}.${imgExtension}`);

    try {
      await formatMultipleImagesFromOneSource({
        inputPath: sourceFilePath,
        tasks: [
          // 低清大图（webp）
          {
            outputPath: bigLowPath,
            quality: 40, //建议40-45
          },
          // 预览图（webp, 600px）
          {
            outputPath: previewPath,
            quality: 50, //建议50-55
            resizeWidth: 600,
          },
        ],
      });
    } catch (e) {
      // 这里一定等到所有分支结束才会进入（因为上游用的是 allSettled）
      const toRemove = Array.isArray(e.successPaths) && e.successPaths.length ? e.successPaths : [bigLowPath, previewPath]; // 兜底：按预期列表删
      await rollbackMany(toRemove);
      // // 失败兜底：把源文件挪到 failed
      try {
        const failedPath = path.join(failedFolder, filename);
        await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
      } catch {}
      return;
    }

    // ======== 先写库（creationDate 为空；monthKey/yearKey = 'unknown'；bigHigh 先留空或保留旧值）========
    const imageData = {
      originalImageUrl: "", // 先空着，待 metaWorker 填充
      bigHighQualityImageUrl: "", // 先空着，待 metaWorker 填充
      bigLowQualityImageUrl: `/${process.env.PROCESSED_BIG_LOW_IMAGE_DIR}/${imageHash}.${imgExtension}`,
      previewImageUrl: `/${process.env.PROCESSED_PREVIEW_IMAGE_DIR}/${imageHash}.${imgExtension}`,
      creationDate: null,
      hash: imageHash,
      userId,
      monthKey: "unknown",
      yearKey: "unknown",
    };

    try {
      await saveNewImage(imageData);
      await redisClient.sadd(userSetKey(userId), imageHash);
    } catch (e) {
      // 回滚已产出的 webp
      await rollbackMany([bigLowPath, previewPath]);
      // 移到 failed
      try {
        const failedPath = path.join(failedFolder, filename);
        await fsExtra.move(sourceFilePath, failedPath, { overwrite: true });
      } catch {}
      return;
    }

    // ======== 入 Meta 队列做“慢活”（EXIF + 高清 AVIF + DB 更新）========
    await metaQueue.add("postProcess", {
      userId,
      imageHash,
      filename,
      sourceFilePath,
      bigHighExt: process.env.IMAGE_EXTENSION_AVIF,
    });
  } finally {
    if (lockKey) {
      try {
        await redisClient.del(lockKey);
      } catch {}
    }
  }
}

module.exports = {
  processAndSaveSingleImage,
};
