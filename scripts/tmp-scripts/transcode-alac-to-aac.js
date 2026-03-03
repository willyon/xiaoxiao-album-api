/*
 * 将已存储的 ALAC 音频转码为 AAC，以支持 Chrome 播放
 * Chrome 不支持 ALAC，Safari 支持；转码后两者均可播放
 *
 * @Usage: node scripts/tmp-scripts/transcode-alac-to-aac.js
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

async function getAudioPath(originalStorageKey) {
  const data = await storageService.storage.getFileData(originalStorageKey);
  if (typeof data === "string") {
    return { path: data, isLocal: true };
  }
  if (Buffer.isBuffer(data)) {
    const ext = path.extname(originalStorageKey) || ".m4a";
    const tempPath = path.join(os.tmpdir(), `transcode-alac-${Date.now()}${ext}`);
    await fs.writeFile(tempPath, data);
    return { path: tempPath, isLocal: false };
  }
  throw new Error("getFileData 返回了无效类型");
}

async function main() {
  const rows = db
    .prepare(
      `SELECT id, user_id, original_storage_key
       FROM images
       WHERE media_type = 'audio' AND deleted_at IS NULL AND original_storage_key IS NOT NULL`
    )
    .all();

  if (rows.length === 0) {
    console.log("没有需要检查的音频");
    return;
  }

  console.log(`共 ${rows.length} 个音频待检查\n`);

  let transcoded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { id, user_id, original_storage_key } = row;

    try {
      const { path: audioPath, isLocal } = await getAudioPath(original_storage_key);
      if (!isLocal) {
        console.log(`[${i + 1}/${rows.length}] id=${id} 非本地存储，跳过（需手动处理 OSS）`);
        skipped++;
        continue;
      }

      const meta = await audioProcessingService.getAudioMetadata(audioPath);

      if (meta.codec && meta.codec.toLowerCase() === "alac") {
        console.log(`[${i + 1}/${rows.length}] id=${id} 编码=ALAC，正在转码为 AAC...`);
        await audioProcessingService.transcodeToAacIfNeeded(audioPath, meta.codec);
        transcoded++;
        console.log(`  完成`);
      } else {
        skipped++;
        console.log(`[${i + 1}/${rows.length}] id=${id} 编码=${meta.codec || "未知"}，跳过`);
      }
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${rows.length}] id=${id} 失败: ${err.message}`);
    }
  }

  console.log(`\n完成: 转码 ${transcoded}，跳过 ${skipped}，失败 ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
