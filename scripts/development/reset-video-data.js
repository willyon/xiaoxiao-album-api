/*
 * @Description: 开发用：仅清理「视频」相关数据（数据库中 media_type=video 的行及其级联表 + localStorage 下视频文件）
 *   可选：全量 Redis 清理（与 reset-non-user-data.js 相同，需显式传入 --clear-redis）
 * @Usage: node scripts/development/reset-video-data.js [--clear-redis]
 */
const fs = require("fs");
const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const args = process.argv.slice(2);
const CLEAR_REDIS = args.includes("--clear-redis");

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { getRedisClient } = require(path.join(projectRoot, "src", "services", "redisClient"));

/** 与 reset-non-user-data.js 中的视频扩展名一致，仅删除这类文件 */
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".3gp",
  ".mts",
  ".m2ts",
  ".ts",
  ".flv",
  ".wmv",
  ".mpeg",
  ".mpg",
]);

async function clearRedisAllKeys() {
  console.log("\n[2/3] 清理 Redis 全部缓存（--clear-redis）...");
  const redisClient = getRedisClient();

  try {
    await redisClient.ping();
    let cursor = "0";
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, "MATCH", "*", "COUNT", 500);
      cursor = nextCursor;
      if (keys.length > 0) {
        if (typeof redisClient.unlink === "function") {
          totalDeleted += await redisClient.unlink(...keys);
        } else {
          totalDeleted += await redisClient.del(...keys);
        }
      }
    } while (cursor !== "0");

    console.log(`  🎉 Redis 清理完成：删除 ${totalDeleted} 个 key`);
    return { deletedKeys: totalDeleted };
  } finally {
    await redisClient.quit().catch(() => {});
  }
}

function walkAndDeleteVideoFiles(rootDir) {
  let deletedFiles = 0;
  let scannedFiles = 0;

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        fs.unlinkSync(fullPath);
        deletedFiles += 1;
      }
    }
  }

  walk(rootDir);
  return { scannedFiles, deletedFiles };
}

function clearLocalStorageVideosOnly() {
  console.log("\n[3/3] 清理 localStorage 下视频文件（按扩展名，不删图片）...");
  const localStorageDir = path.join(projectRoot, "localStorage");

  if (!fs.existsSync(localStorageDir)) {
    console.log("  ℹ️ 未找到 localStorage 目录，跳过");
    return { scannedFiles: 0, deletedFiles: 0 };
  }

  const result = walkAndDeleteVideoFiles(localStorageDir);
  console.log(
    `  🎉 localStorage 清理完成：扫描 ${result.scannedFiles} 个文件，删除 ${result.deletedFiles} 个视频文件`,
  );
  return result;
}

/**
 * 删除 media 表中视频行；依赖外键 ON DELETE CASCADE 清理 video_keyframes、video_transcripts、
 * album_media、media_face_embeddings 等子表（见 initTableModel）
 */
function deleteVideoRowsFromMedia() {
  console.log("\n[1/3] 清理数据库中视频记录（media_type = 'video'）...");
  const before = db.prepare(`SELECT COUNT(*) AS c FROM media WHERE media_type = 'video'`).get().c || 0;
  if (before === 0) {
    console.log("  ℹ️ 无视频记录，跳过 DELETE");
    return { deletedRows: 0 };
  }
  const result = db.prepare(`DELETE FROM media WHERE media_type = 'video'`).run();
  console.log(`  ✅ 删除 ${result.changes} 行视频 media（级联子表由外键处理）`);
  return { deletedRows: result.changes };
}

async function main() {
  console.log("==============================================");
  console.log("🎬 仅清理视频：DB(media 视频) + localStorage(视频扩展名)");
  if (CLEAR_REDIS) {
    console.log("   已启用 --clear-redis：将清空全部 Redis（与 reset-non-user-data 相同）");
  } else {
    console.log("   未传 --clear-redis：跳过 Redis（避免影响图片相关缓存）");
  }
  console.log("==============================================");

  const dbResult = deleteVideoRowsFromMedia();

  let redisResult = { deletedKeys: 0 };
  if (CLEAR_REDIS) {
    redisResult = await clearRedisAllKeys();
  } else {
    console.log("\n[2/3] 跳过 Redis（若需全量清缓存请追加 --clear-redis）");
  }

  const storageResult = clearLocalStorageVideosOnly();

  console.log("\n✅ 视频相关清理完成");
  console.log(`- 数据库: 删除 ${dbResult.deletedRows} 条视频 media`);
  if (CLEAR_REDIS) {
    console.log(`- Redis: ${redisResult.deletedKeys} 个 key`);
  } else {
    console.log(`- Redis: 未清理`);
  }
  console.log(`- localStorage: 删除 ${storageResult.deletedFiles} 个视频文件`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 清理失败:", error);
    process.exit(1);
  });
