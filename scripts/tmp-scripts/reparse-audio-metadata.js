/*
 * 重新解析已上传音频文件的元数据（含 GPS、录制时间）
 * 支持：M4A creation_time、MP3 TDRC/TYER+TDAT+TIME、FLAC date 等
 *
 * @Usage: node scripts/tmp-scripts/reparse-audio-metadata.js
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
const audioProcessingService = require(path.join(projectRoot, "src", "services", "audioProcessingService"));
const imageMetadataService = require(path.join(projectRoot, "src", "services", "imageMetadataService"));
const imageModel = require(path.join(projectRoot, "src", "models", "imageModel"));
const { timestampToYearMonth, timestampToYear, timestampToDate, timestampToDayOfWeek } = require(path.join(projectRoot, "src", "utils", "formatTime"));

/**
 * @returns {{ audioPath: string, isTemp: boolean }}
 */
async function getAudioPath(originalStorageKey) {
  const data = await storageService.storage.getFileData(originalStorageKey);
  if (typeof data === "string") {
    return { audioPath: data, isTemp: false };
  }
  if (Buffer.isBuffer(data)) {
    const ext = path.extname(originalStorageKey) || ".m4a";
    const tempPath = path.join(os.tmpdir(), `reparse-audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    await fs.writeFile(tempPath, data);
    return { audioPath: tempPath, isTemp: true };
  }
  throw new Error("getFileData 返回了无效类型");
}

async function main() {
  const rows = db
    .prepare(
      `SELECT id, user_id, image_hash, original_storage_key
       FROM images
       WHERE media_type = 'audio' AND deleted_at IS NULL AND original_storage_key IS NOT NULL`
    )
    .all();

  if (rows.length === 0) {
    console.log("没有需要重新解析的音频");
    return;
  }

  console.log(`共 ${rows.length} 个音频待重新解析元数据\n`);

  let updated = 0;
  let failed = 0;
  let gpsAdded = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { id, user_id, image_hash, original_storage_key } = row;

    let tempPath = null;

    try {
      const { audioPath, isTemp } = await getAudioPath(original_storage_key);
      tempPath = isTemp ? audioPath : null;

      const meta = await audioProcessingService.getAudioMetadata(audioPath);

      const captureTime = meta.creationTime ?? undefined;
      const monthKey = timestampToYearMonth(captureTime);
      const yearKey = timestampToYear(captureTime);
      const dateKey = timestampToDate(captureTime);
      const dayKey = timestampToDayOfWeek(captureTime);

      let gpsLocation = null;
      let country = null;
      let city = null;
      if (meta.gpsLatitude != null && meta.gpsLongitude != null) {
        try {
          const locInfo = await imageMetadataService.analyzeLocationInfo(meta.gpsLatitude, meta.gpsLongitude);
          gpsLocation = locInfo?.gpsLocation || null;
          country = locInfo?.country || null;
          city = locInfo?.city || null;
          gpsAdded++;
        } catch (e) {
          console.warn(`[${i + 1}/${rows.length}] id=${id} 逆地理编码失败: ${e.message}`);
        }
      }

      imageModel.updateImageMetadata({
        userId: user_id,
        imageHash: image_hash,
        creationDate: captureTime,
        monthKey,
        yearKey,
        dateKey,
        dayKey,
        gpsLatitude: meta.gpsLatitude,
        gpsLongitude: meta.gpsLongitude,
        gpsLocation,
        country,
        city,
        durationSec: meta.duration,
        videoCodec: meta.codec,
      });

      updated++;
      const gpsInfo = city ? ` GPS→${city}` : "";
      console.log(`[${i + 1}/${rows.length}] ✅ id=${id} user=${user_id}${gpsInfo}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${rows.length}] ❌ id=${id} user=${user_id}: ${err.message}`);
    } finally {
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (_) {}
      }
    }
  }

  console.log(`\n完成: 成功 ${updated}（其中新增 GPS ${gpsAdded}），失败 ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
