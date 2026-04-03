/*
 * @Description: 模拟高德 https 各类失败，验证 geocodingService 是否降级到本地逆地理（不发起真实网络请求）
 *
 * Usage（xiaoxiao-project-service 根目录）:
 *   node scripts/tmp-scripts/test-geocoding-amap-fallback.js
 */

const path = require("path");
const https = require("https");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config({ path: path.join(projectRoot, ".env") });

const geoModulePath = path.join(projectRoot, "src/services/geocodingService.js");
const amapModulePath = path.join(projectRoot, "src/services/amapReverseGeocodeService.js");

const originalHttpsGet = https.get;

/** 台北附近 WGS，本地行政区划应能命中台湾 */
const LAT_TW = 25.033;
const LNG_TW = 121.5654;

/** 巴黎 WGS，本地无命中时应走全球国家 → 法国 */
const LAT_FR = 48.8566;
const LNG_FR = 2.3522;

function clearGeocodingCache() {
  delete require.cache[geoModulePath];
  delete require.cache[amapModulePath];
}

function loadGeocoding() {
  clearGeocodingCache();
  return require(geoModulePath);
}

function makeMockResponse(bodyStr) {
  if (typeof bodyStr !== "string") bodyStr = JSON.stringify(bodyStr);
  return {
    on(ev, fn) {
      if (ev === "data") {
        setImmediate(() => fn(Buffer.from(bodyStr, "utf8")));
      }
      if (ev === "end") {
        setImmediate(() => {
          setImmediate(() => fn());
        });
      }
    },
  };
}

/**
 * @param {object} opts
 * @param {'timeout'|'neterr'|'badjson'|'status0'|'empty_ok'|'success'} opts.behavior
 */
function installMock(opts) {
  const { behavior } = opts;

  https.get = function mockGet(url, options, callback) {
    const req = {
      on(ev, fn) {
        if (ev === "error" && behavior === "neterr") {
          setImmediate(() => fn(new Error("ECONNREFUSED")));
        }
        return this;
      },
      setTimeout(ms, fn) {
        if (behavior === "timeout") {
          setImmediate(() => fn());
        }
        return this;
      },
      destroy() {},
    };

    if (behavior === "timeout") {
      return req;
    }
    if (behavior === "neterr") {
      return req;
    }

    if (behavior === "badjson") {
      setImmediate(() => {
        callback({
          on(ev, fn) {
            if (ev === "data") setImmediate(() => fn(Buffer.from("{not-json", "utf8")));
            if (ev === "end") setImmediate(() => setImmediate(() => fn()));
          },
        });
      });
      return req;
    }

    if (behavior === "status0") {
      setImmediate(() => {
        callback(makeMockResponse({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" }));
      });
      return req;
    }

    if (behavior === "empty_ok") {
      setImmediate(() => {
        callback(
          makeMockResponse({
            status: "1",
            infocode: "10000",
            regeocode: {
              formatted_address: "",
              addressComponent: {},
            },
          }),
        );
      });
      return req;
    }

    if (behavior === "success") {
      setImmediate(() => {
        callback(
          makeMockResponse({
            status: "1",
            infocode: "10000",
            regeocode: {
              formatted_address: "模拟高德成功地址",
              addressComponent: {
                country: "中国",
                province: "台湾省",
                city: [],
                district: "",
              },
            },
          }),
        );
      });
      return req;
    }

    throw new Error(`unknown behavior: ${behavior}`);
  };
}

function restoreHttps() {
  https.get = originalHttpsGet;
}

async function runCase(name, behavior, lat, lng, assertions) {
  process.env.AMAP_API_KEY = "test-fake-key-for-mock";
  installMock({ behavior });
  const { getLocationFromCoordinates } = loadGeocoding();
  try {
    const result = await getLocationFromCoordinates(lat, lng);
    assertions(result);
    console.log(`✅ ${name}`);
    console.log(`   → ${JSON.stringify(result)}`);
  } catch (e) {
    console.error(`❌ ${name}`, e);
    process.exitCode = 1;
  } finally {
    restoreHttps();
  }
  console.log("");
}

async function main() {
  console.log("=== 高德 mock 降级测试（本地 data/geo）===\n");

  await runCase("1. 请求超时 → 降级", "timeout", LAT_TW, LNG_TW, (r) => {
    if (!r || !r.province) throw new Error("应命中本地省/区划");
    if (r.province !== "台湾" && r.formattedAddress !== "台湾") throw new Error(`意外结果: ${JSON.stringify(r)}`);
  });

  await runCase("2. 网络错误 → 降级", "neterr", LAT_TW, LNG_TW, (r) => {
    if (!r || !r.province) throw new Error("应命中本地");
  });

  await runCase("3. JSON 不完整 → 降级", "badjson", LAT_TW, LNG_TW, (r) => {
    if (!r || !r.province) throw new Error("应命中本地");
  });

  await runCase("4. status≠1 → 降级", "status0", LAT_TW, LNG_TW, (r) => {
    if (!r || !r.province) throw new Error("应命中本地");
  });

  await runCase("5. status=1 但无有效字段 → 降级", "empty_ok", LAT_TW, LNG_TW, (r) => {
    if (!r || !r.province) throw new Error("应命中本地");
  });

  await runCase("6. 高德成功 → 不降级（用 mock 结果）", "success", LAT_TW, LNG_TW, (r) => {
    if (!r || r.formattedAddress !== "模拟高德成功地址") throw new Error("应直接返回高德解析结果");
    if (r.province !== "台湾省") throw new Error("应保留高德 province");
  });

  await runCase("7. 台湾降级命中后；境外点降级走全球（巴黎）", "status0", LAT_FR, LNG_FR, (r) => {
    if (!r || !r.country) throw new Error("全球应返回国家");
    if (r.country !== "法国") throw new Error(`期望法国，得到 ${r.country}`);
  });

  console.log("全部场景完成。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
