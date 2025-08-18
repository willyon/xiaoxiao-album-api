/*
 * @Author: zhangshouchang
 * @Date: 2025-08-11
 * @LastEditors: zhangshouchang
 * @Description: 独立图片处理worker模块
 */

const logger = require("../utils/logger");
const path = require("path");
const fsExtra = require("fs-extra");
const { saveNewImage, cleanupGeneratedFile, formatSingleImage } = require("../services/imageService");
const { getRedisClient } = require("../services/redisClient");
const { userSetKey } = require("./userImageHashset");
const { imageMetaQueue } = require("../queues/imageMetaQueue");
const timeIt = require("../utils/timeIt");

// 失败图片存放目录（防止失败文件滞留待处理目录）
const failedFolder = path.join(__dirname, "..", "..", process.env.FAILED_IMAGE_DIR);
// 重复图片存放目录
const duplicateFolder = path.join(__dirname, "..", "..", process.env.DUPLICATE_IMAGE_DIR);
// 转换预览图目录
const thumbnailFolder = path.join(__dirname, "..", "..", process.env.PROCESSED_THUMBNAIL_IMAGE_DIR);

// 确保目标文件夹存在 若不存在 会自动创建
fsExtra.ensureDirSync(failedFolder);
fsExtra.ensureDirSync(duplicateFolder);
fsExtra.ensureDirSync(thumbnailFolder);

async function _handleRemoveThumbnail(thumbnailPath, filename, sourcePath) {
  try {
    await cleanupGeneratedFile(thumbnailPath);
  } catch (err) {
    // 失败兜底：把源文件挪到 failed
    try {
      const failedPath = path.join(failedFolder, filename);
      await fsExtra.move(sourcePath, failedPath, { overwrite: true });
    } catch (e) {
      // 记录移动到failed目录失败，但不要覆盖原始 err
      logger.error({
        message: `moved to failed Folder failed: ${e?.message}`,
        stack: e?.stack,
        details: { failedPath, filename, sourcePath },
      });
    }
    throw err;
  }
}

// 迁移重复图片到duplicateFolder
async function _handleDuplicatedImage(fileInfo) {
  const { filename, path: sourcePath } = fileInfo;
  const duplicateFilePath = path.join(duplicateFolder, filename);
  try {
    await fsExtra.move(sourcePath, duplicateFilePath, { overwrite: true });
  } catch (error) {
    logger.error({
      message: `move duplicated file failed: ${error?.message}`,
      stack: error?.stack,
      details: { step: "move duplicated file", file: sourcePath, duplicateFilePath },
    });
  }
}

// 原子化：先查集合 → 抢锁 → 失败则再查集合 → 再决定 busy/重复
async function _ensureProcessRightOrShortCircuit(fileInfo, redisClient) {
  const { userId, imageHash } = fileInfo;
  const setKey = userSetKey(userId);

  // 1) 快路径：集合命中，立即按重复处理
  const already = await redisClient.sismember(setKey, imageHash);
  if (already === 1) {
    await _handleDuplicatedImage(fileInfo);
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
      await _handleDuplicatedImage(fileInfo);
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
  const { filename, path: sourcePath, userId, imageHash } = fileInfo;
  console.log("文件名:", filename);
  const redisClient = getRedisClient();
  let lockKey;

  try {
    // 去重 + 分布式锁
    // const { proceed, lockKey: key } = await timeIt("dedupeAndLock", async () => _ensureProcessRightOrShortCircuit(fileInfo, redisClient));
    const { proceed, lockKey: key } = await _ensureProcessRightOrShortCircuit(fileInfo, redisClient);
    if (!proceed) return;
    lockKey = key;

    // ======== 快路径：仅产出 preview.webp + bigLow.webp ========
    const imgExtension = process.env.IMAGE_EXTENSION_WEBP || "webp";
    const thumbnailPath = path.join(thumbnailFolder, `${imageHash}.${imgExtension}`);

    try {
      await timeIt(
        "formatSingleImage",
        async () => {
          // 预览图（webp, 600px）
          await formatSingleImage({
            inputPath: sourcePath,
            outputPath: thumbnailPath,
            quality: 50, //建议50-55
            resizeWidth: 600,
          });
        },
        imageHash,
      );
      // await formatSingleImage({
      //   inputPath: sourcePath,
      //   outputPath: thumbnailPath,
      //   quality: 50, //建议50-55
      //   resizeWidth: 600,
      // });
    } catch (error) {
      try {
        await _handleRemoveThumbnail(thumbnailPath, filename, sourcePath);
      } catch (cleanupErr) {
        // 记录清理失败，但不要覆盖原始 error
        logger.error({
          message: `cleanup thumbnail failed: ${cleanupErr?.message}`,
          stack: cleanupErr?.stack,
          details: { thumbnailPath, filename, sourcePath },
        });
      }
      throw error;
    }

    // ======== 先写库（creationDate 为空；monthKey/yearKey = 'unknown'；bigHigh 先留空或保留旧值）========
    const imageData = {
      originalUrl: "", // 先空着，待 imageMetaWorker 填充
      highResUrl: "", // 先空着，待 imageMetaWorker 填充
      thumbnailUrl: `/${process.env.PROCESSED_THUMBNAIL_IMAGE_DIR}/${imageHash}.${imgExtension}`,
      creationDate: null,
      hash: imageHash,
      userId,
      monthKey: "unknown",
      yearKey: "unknown",
    };

    try {
      // await timeIt("db.insert + redis.sadd", async () => {
      //   await saveNewImage(imageData);
      //   await redisClient.sadd(userSetKey(userId), imageHash);
      // });
      await saveNewImage(imageData);
      await redisClient.sadd(userSetKey(userId), imageHash);
    } catch (error) {
      try {
        await _handleRemoveThumbnail(thumbnailPath, filename, sourcePath);
      } catch (cleanupErr) {
        // 记录清理失败，但不要覆盖原始 error
        logger.error({
          message: `cleanup thumbnail failed: ${cleanupErr?.message}`,
          stack: cleanupErr?.stack,
          details: { thumbnailPath, filename, sourcePath },
        });
      }
      throw error;
    }

    // ======== 入 Meta 队列做“慢活”（EXIF + 高清 AVIF + DB 更新）========
    // await timeIt("enqueue.meta", async () =>
    //   imageMetaQueue.add(process.env.IMAGE_META_QUEUE_NAME, {
    //     userId,
    //     imageHash,
    //     filename,
    //     sourcePath,
    //     highResExt: process.env.IMAGE_EXTENSION_AVIF,
    //   }),
    // );
    await imageMetaQueue.add(process.env.IMAGE_META_QUEUE_NAME, {
      userId,
      imageHash,
      filename,
      sourcePath,
      highResExt: process.env.IMAGE_EXTENSION_AVIF,
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
