/*
 * @Description: 插入 5 条仅用于测试逆地理链路的 media：非洲 / 欧洲 / 亚洲 / 台湾 / 南美洲各一点。
 * 使用与线上一致的 getLocationFromCoordinates（高德或本地中国 + 全球兜底），写入 gps_*、country、province、city。
 *
 * @Usage（在 xiaoxiao-project-service 目录）:
 *   TEST_USER_ID=1 node scripts/tmp-scripts/seed-test-geo-media.js
 *
 * 未设置 TEST_USER_ID 时使用 users 表中 id 最小的用户。
 */

const path = require("path");
const crypto = require("crypto");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config({ path: path.join(projectRoot, ".env") });

const { db } = require(path.join(projectRoot, "src", "services", "database"));
const { getLocationFromCoordinates } = require(path.join(projectRoot, "src", "services", "geocodingService"));

/** WGS-84 经纬度；名称仅用于日志 */
const TEST_POINTS = [
  { key: "africa", label: "非洲·内罗毕", lat: -1.286389, lng: 36.817223 },
  { key: "europe", label: "欧洲·巴黎", lat: 48.8566, lng: 2.3522 },
  { key: "asia", label: "亚洲·东京", lat: 35.6762, lng: 139.6503 },
  { key: "taiwan", label: "台湾·台北", lat: 25.033, lng: 121.5654 },
  { key: "south_america", label: "南美洲·圣保罗", lat: -23.5505, lng: -46.6333 },
];

function resolveUserId() {
  const fromEnv = process.env.TEST_USER_ID;
  if (fromEnv != null && fromEnv !== "") {
    const n = parseInt(fromEnv, 10);
    if (!Number.isNaN(n) && n > 0) return n;
    console.warn("TEST_USER_ID 无效，将回退为 users 表首条用户");
  }
  const row = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
  if (!row) {
    throw new Error("users 表无用户，请先注册或设置 TEST_USER_ID");
  }
  return row.id;
}

async function main() {
  const userId = resolveUserId();
  const now = Date.now();

  const insert = db.prepare(`
    INSERT INTO media (
      user_id,
      file_hash,
      created_at,
      media_type,
      meta_pipeline_status,
      gps_latitude,
      gps_longitude,
      gps_location,
      country,
      province,
      city
    ) VALUES (?, ?, ?, 'image', 'success', ?, ?, ?, ?, ?, ?)
  `);

  console.log(`使用 user_id=${userId}，开始逆地理并写入 media …\n`);

  for (const p of TEST_POINTS) {
    const fileHash = `test-geo-${p.key}-${now}-${crypto.randomBytes(4).toString("hex")}`;
    let loc = null;
    try {
      loc = await getLocationFromCoordinates(p.lat, p.lng);
    } catch (e) {
      console.error(`[${p.label}] 逆地理异常:`, e.message);
    }

    const gpsLocation = loc?.formattedAddress ?? null;
    const country = loc?.country ?? null;
    const province = loc?.province ?? null;
    const city = loc?.city ?? null;

    const info = insert.run(
      userId,
      fileHash,
      now,
      p.lat,
      p.lng,
      gpsLocation,
      country,
      province,
      city,
    );

    console.log(`--- ${p.label} (${p.lat}, ${p.lng}) ---`);
    console.log(`  file_hash: ${fileHash}`);
    console.log(`  gps_location: ${gpsLocation ?? "(null)"}`);
    console.log(`  country: ${country ?? "(null)"} | province: ${province ?? "(null)"} | city: ${city ?? "(null)"}`);
    console.log(`  row id: ${info.lastInsertRowid}, changes: ${info.changes}\n`);
  }

  console.log("完成。可在前端刷新地点列表 / 筛选「城市」接口查看分组与字段。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
