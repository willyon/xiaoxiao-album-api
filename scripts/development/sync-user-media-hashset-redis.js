/*
 * @Description: 将「用户上传去重」用的 Redis 集合与数据库中当前未删除媒体的 file_hash 对齐。
 * 典型场景：旧版本彻底删除媒体后未清理 Redis，导致同文件无法再次上传。
 *
 * 做法：删除 images:hashset:user:{uid}、images:hashset:ready:{uid}、lock:images:hashset:init:{uid}
 * 后调用 ensureUserSetReady，从 DB 重新 SADD。
 *
 * 用法:
 *   node scripts/development/sync-user-media-hashset-redis.js --user-id=123
 *   node scripts/development/sync-user-media-hashset-redis.js 123
 *   node scripts/development/sync-user-media-hashset-redis.js --all
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { getRedisClient } = require(path.join(projectRoot, "src", "services", "redisClient"));
const { db } = require(path.join(projectRoot, "src", "services", "database"));
const {
  ensureUserSetReady,
  userSetKey,
  readyKeyOf,
  lockKeyOf,
} = require(path.join(projectRoot, "src", "workers", "userMediaHashset"));

function printHelp() {
  console.log(`
用法:
  node scripts/development/sync-user-media-hashset-redis.js --user-id=<用户ID>
  node scripts/development/sync-user-media-hashset-redis.js <用户ID>
  node scripts/development/sync-user-media-hashset-redis.js --all

说明:
  按当前数据库中 deleted_at IS NULL 的媒体的 file_hash 重建 Redis 去重集合。

选项:
  --user-id=N   只处理指定用户
  --all         合并两类用户：Redis 里已有 images:hashset:user:* 的、以及 DB 里仍有未删除媒体的
  -h, --help    显示帮助
`);
}

async function scanRedisUserIds(redis) {
  const ids = new Set();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "images:hashset:user:*", "COUNT", 200);
    cursor = next;
    for (const k of keys) {
      const m = String(k).match(/^images:hashset:user:(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
  } while (cursor !== "0");
  return ids;
}

function dbUserIdsWithActiveMedia() {
  const stmt = db.prepare(`SELECT DISTINCT user_id FROM media WHERE deleted_at IS NULL`);
  return new Set(stmt.all().map((r) => r.user_id));
}

async function rebuildUserHashset(redis, userId) {
  await redis.del(userSetKey(userId), readyKeyOf(userId), lockKeyOf(userId));
  await ensureUserSetReady(userId);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  let userId = null;
  let all = false;
  for (const a of argv) {
    if (a === "--all") all = true;
    else if (a.startsWith("--user-id=")) {
      userId = parseInt(a.split("=")[1], 10);
    }
  }
  if (!all && (userId == null || !Number.isFinite(userId))) {
    const pos = argv.find((x) => /^\d+$/.test(x));
    if (pos) userId = parseInt(pos, 10);
  }
  return { userId, all };
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }

  const { userId, all } = parsed;
  if (!all && (userId == null || !Number.isFinite(userId) || userId <= 0)) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const redis = getRedisClient();
  await new Promise((r) => setTimeout(r, 300));

  if (all) {
    const fromRedis = await scanRedisUserIds(redis);
    const fromDb = dbUserIdsWithActiveMedia();
    const merged = new Set([...fromRedis, ...fromDb]);
    const list = [...merged].sort((a, b) => a - b);
    console.log(`\n将重建 ${list.length} 个用户的上传去重集合（与 DB 对齐）...\n`);
    for (const uid of list) {
      try {
        const before = await redis.scard(userSetKey(uid));
        await rebuildUserHashset(redis, uid);
        const after = await redis.scard(userSetKey(uid));
        console.log(`  user_id=${uid}  hash 数量: ${before} → ${after}`);
      } catch (e) {
        console.error(`  user_id=${uid} 失败:`, e.message);
      }
    }
    console.log("\n完成。\n");
  } else {
    const before = await redis.scard(userSetKey(userId));
    await rebuildUserHashset(redis, userId);
    const after = await redis.scard(userSetKey(userId));
    console.log(`\n用户 ${userId} 去重集合已重建，hash 数量: ${before} → ${after}\n`);
  }

  await redis.quit().catch(() => {});
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
