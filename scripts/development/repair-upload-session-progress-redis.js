/*
 * @Description: 修复 Redis 中 upload:session:{sessionId} 的「媒体整理」进度与 uploadedCount 不一致问题。
 * 典型场景：回收站静默恢复后只写了 uploadedCount、未写 highResDone，导致媒体处理页一直 0/N。
 *
 * 规则（与 uploadProgressSnapshot.computeMediaStageDone 一致）：
 *   mediaDone = highResDone + highResErrors + workerSkippedCount
 *   若 uploadedCount > mediaDone，则将差额补到 highResDone（视为应已完成流水线但未计数）。
 *
 * 用法:
 *   node scripts/development/repair-upload-session-progress-redis.js           # 仅打印将修复项（dry-run）
 *   node scripts/development/repair-upload-session-progress-redis.js --apply  # 写入 Redis 并 publish 进度
 *   node scripts/development/repair-upload-session-progress-redis.js --apply --session-id=<uuid>
 *
 * 另：用户 hash 集合与 DB 对齐请用 sync-user-media-hashset-redis.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { getRedisClient } = require(path.join(projectRoot, "src", "services", "redisClient"));
const { normalizeProgressData } = require(path.join(projectRoot, "src", "utils", "uploadProgressSnapshot"));

function toInt(v) {
  return Number.parseInt(v, 10) || 0;
}

/** 仅主会话 Hash：upload:session:<id>，排除 counter_marker / failures / media_ids 等子 key */
function isMainUploadSessionKey(key) {
  const parts = String(key).split(":");
  return parts.length === 3 && parts[0] === "upload" && parts[1] === "session";
}

function sessionIdFromKey(key) {
  return String(key).split(":").slice(2).join(":"); // 若 id 含 : 仍兼容
}

async function scanMainSessionKeys(redis) {
  const out = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "upload:session:*", "COUNT", 200);
    cursor = next;
    for (const k of batch) {
      if (isMainUploadSessionKey(k)) out.push(k);
    }
  } while (cursor !== "0");
  return out;
}

async function publishProgress(redis, sessionId) {
  const redisData = await redis.hgetall(`upload:session:${sessionId}`);
  if (!redisData || Object.keys(redisData).length === 0) return;
  const progressData = normalizeProgressData(sessionId, redisData);
  await redis.publish(`session:${sessionId}:progress`, JSON.stringify(progressData));
}

async function repairOneSession(redis, sessionKey, apply) {
  const sessionId = sessionIdFromKey(sessionKey);
  const data = await redis.hgetall(sessionKey);
  if (!data || Object.keys(data).length === 0) return null;

  const uploadedCount = toInt(data.uploadedCount);
  const highResDone = toInt(data.highResDone);
  const highResErrors = toInt(data.highResErrors);
  const workerSkippedCount = toInt(data.workerSkippedCount);

  const mediaDone = highResDone + highResErrors + workerSkippedCount;
  const deficit = uploadedCount - mediaDone;

  if (deficit <= 0) {
    return { sessionId, skipped: true, reason: "already aligned" };
  }

  if (!apply) {
    return {
      sessionId,
      skipped: false,
      dryRun: true,
      uploadedCount,
      mediaDone,
      deficit,
      wouldAddToHighResDone: deficit,
    };
  }

  await redis.hincrby(sessionKey, "highResDone", deficit);
  await publishProgress(redis, sessionId);

  return {
    sessionId,
    skipped: false,
    dryRun: false,
    uploadedCount,
    deficitApplied: deficit,
  };
}

function printHelp() {
  console.log(`
用法:
  node scripts/development/repair-upload-session-progress-redis.js
  node scripts/development/repair-upload-session-progress-redis.js --apply
  node scripts/development/repair-upload-session-progress-redis.js --apply --session-id=<会话ID>

说明:
  扫描 upload:session:* 主 Hash，若 uploadedCount > highResDone+highResErrors+workerSkippedCount，
  则把差额补到 highResDone（与前端「媒体整理」= actualHighResDone / uploadedCount 一致）。

选项:
  --apply              默认仅 dry-run；加此参数才执行 hincrby 并 publish
  --session-id=<id>    只处理指定会话
  -h, --help
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const apply = argv.includes("--apply");
  let onlySessionId = null;
  for (const a of argv) {
    if (a.startsWith("--session-id=")) {
      onlySessionId = a.split("=")[1];
    }
  }

  const redis = getRedisClient();
  await new Promise((r) => setTimeout(r, 200));

  let keys = await scanMainSessionKeys(redis);
  if (onlySessionId) {
    const k = `upload:session:${onlySessionId}`;
    if (!(await redis.exists(k))) {
      console.error(`未找到会话 key: ${k}`);
      process.exitCode = 1;
      return;
    }
    keys = [k];
  }

  console.log(
    `\n${apply ? "⚠️  执行修复" : "🔍 仅预览（加 --apply 写入）"}，共 ${keys.length} 个 upload:session 主 key\n`,
  );

  let fixed = 0;
  let skipped = 0;

  for (const key of keys) {
    const result = await repairOneSession(redis, key, apply);
    if (!result) continue;
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.dryRun) {
      console.log(
        `  [dry-run] ${result.sessionId}  uploaded=${result.uploadedCount} mediaDone=${result.mediaDone}  → 将 highResDone += ${result.deficit}`,
      );
      fixed++;
    } else {
      console.log(`  [done]  ${result.sessionId}  highResDone += ${result.deficitApplied}`);
      fixed++;
    }
  }

  console.log(`\n完成：已处理需对齐 ${fixed} 个，跳过（已对齐）${skipped} 个\n`);

  await redis.quit().catch(() => {});
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
