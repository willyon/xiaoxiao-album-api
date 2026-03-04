/*
 * 调试：打印 ffprobe 对第一个音频的原始 JSON 输出，用于排查元数据解析问题
 * @Usage: node scripts/tmp-scripts/debug-audio-ffprobe.js
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const storageService = require(path.join(projectRoot, "src", "services", "storageService"));
const fs = require("fs").promises;
const os = require("os");
const { spawn } = require("child_process");

async function getAudioPath(originalStorageKey) {
  const data = await storageService.storage.getFileData(originalStorageKey);
  if (typeof data === "string") {
    return { audioPath: data, isTemp: false };
  }
  if (Buffer.isBuffer(data)) {
    const ext = path.extname(originalStorageKey) || ".m4a";
    const tempPath = path.join(os.tmpdir(), `debug-audio-${Date.now()}${ext}`);
    await fs.writeFile(tempPath, data);
    return { audioPath: tempPath, isTemp: true };
  }
  throw new Error("getFileData 返回了无效类型");
}

const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

function runFfprobe(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_PATH, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      audioPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", () => {});
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffprobe exit ${code}`));
      else resolve(JSON.parse(stdout));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const row = db.prepare(
    `SELECT id, original_storage_key FROM images
     WHERE media_type = 'audio' AND deleted_at IS NULL AND original_storage_key IS NOT NULL
     LIMIT 1`
  ).get();

  if (!row) {
    console.log("没有音频");
    return;
  }

  console.log(`调试音频 id=${row.id}, key=${row.original_storage_key}\n`);

  let tempPath = null;
  try {
    const { audioPath, isTemp } = await getAudioPath(row.original_storage_key);
    tempPath = isTemp ? audioPath : null;
    console.log(`本地路径: ${audioPath}\n`);

    const data = await runFfprobe(audioPath);
    console.log("=== format.tags ===");
    console.log(JSON.stringify(data.format?.tags || {}, null, 2));
    console.log("\n=== streams[0].tags (首个 audio 流) ===");
    const audioStream = data.streams?.find((s) => s.codec_type === "audio");
    console.log(JSON.stringify(audioStream?.tags || {}, null, 2));
  } finally {
    if (tempPath) {
      try { await fs.unlink(tempPath); } catch (_) {}
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
