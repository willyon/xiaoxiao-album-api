/*
 * 重新生成现有视频的缩略图
 * 用于应用 videoProcessingService.extractFirstFrame 的色彩修正修复（避免首帧偏白）
 *
 * @Usage: node scripts/tmp-scripts/regenerate-video-thumbnails.js
 */

const path = require("path");
const fs = require("fs").promises;
const os = require("os");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const storageService = require(path.join(projectRoot, "src", "services", "storageService"));
const { storeVideoThumbnail } = require(path.join(projectRoot, "src", "services", "videoProcessingService"));

/**
 * @returns {{ videoPath: string, isTemp: boolean }}
 */
async function getVideoPath(adapter, originalStorageKey) {
  const data = await adapter.getFileData(originalStorageKey);
  if (typeof data === "string") {
    return { videoPath: data, isTemp: false };
  }
  if (Buffer.isBuffer(data)) {
    const ext = path.extname(originalStorageKey) || ".mp4";
    const tempPath = path.join(os.tmpdir(), `regen-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    await fs.writeFile(tempPath, data);
    return { videoPath: tempPath, isTemp: true };
  }
  throw new Error("getFileData 返回了无效类型");
}

async function main() {
  const rows = db
    .prepare(
      `SELECT id, user_id, thumbnail_storage_key, original_storage_key
       FROM media
       WHERE media_type = 'video' AND deleted_at IS NULL`,
    )
    .all();

  if (rows.length === 0) {
    console.log("没有需要处理的视频");
    return;
  }

  console.log(`共 ${rows.length} 个视频待重新生成缩略图\n`);

  const adapter = storageService.storage;
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { id, user_id, thumbnail_storage_key, original_storage_key } = row;

    if (!original_storage_key || !thumbnail_storage_key) {
      console.log(`[${i + 1}/${rows.length}] 跳过 id=${id}: 缺少 original_storage_key 或 thumbnail_storage_key`);
      fail++;
      continue;
    }

    let tempPath = null;

    try {
      const { videoPath, isTemp } = await getVideoPath(adapter, original_storage_key);
      tempPath = isTemp ? videoPath : null;

      await storeVideoThumbnail(videoPath, thumbnail_storage_key, adapter);
      ok++;
      console.log(`[${i + 1}/${rows.length}] ✅ id=${id} user=${user_id}`);
    } catch (err) {
      fail++;
      console.error(`[${i + 1}/${rows.length}] ❌ id=${id} user=${user_id}: ${err.message}`);
    } finally {
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  console.log(`\n完成: 成功 ${ok}, 失败 ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
