/*
 * 仅清除指定用户（曾有那 8 个音频）的 Redis hash 缓存
 * 因 DB 已删除那 8 条记录，清除后重建的 hash set 将不再包含它们，可正常重新上传
 *
 * @Usage: node scripts/tmp-scripts/clear-redis-hashset.js [userId]
 *         默认 userId=1
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { getRedisClient } = require(path.join(projectRoot, "src", "services", "redisClient"));
const { userSetKey, readyKeyOf, lockKeyOf } = require(path.join(projectRoot, "src", "workers", "userImageHashset"));

async function main() {
  const userId = parseInt(process.argv[2] || "1", 10);
  const redis = getRedisClient();

  const keys = [
    userSetKey(userId),
    readyKeyOf(userId),
    lockKeyOf(userId),
  ];

  let deleted = 0;
  for (const key of keys) {
    const n = await redis.del(key);
    if (n > 0) {
      deleted++;
      console.log(`删除: ${key}`);
    }
  }

  console.log(`\n完成：已清除用户 ${userId} 的 hash 缓存（${deleted} 个 key），下次上传将重新从 DB 初始化`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    getRedisClient().quit?.().catch(() => {});
  });
