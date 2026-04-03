/*
 * @Author: zhangshouchang
 * @Date: 2026-04-03
 * @Description: 将 Natural Earth ne_50m_admin_0_countries 导出的 globalGeoData.json
 * 精简为仅保留几何 + 国家/地区英文名 + 中文名（用于境外逆地理展示：优先中文，否则英文）。
 *
 * 用法（在项目根 xiaoxiao-project-service 目录）:
 *   node scripts/development/slim-global-geo-data.js
 *
 * 默认读写的路径:
 *   src/data/geo/globalGeoData.json
 *
 * 可选环境变量:
 *   GLOBAL_GEO_IN=/path/to/in.json GLOBAL_GEO_OUT=/path/to/out.json
 */

const fs = require("fs");
const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

const DEFAULT_PATH = path.join(projectRoot, "src", "data", "geo", "globalGeoData.json");

const inPath = process.env.GLOBAL_GEO_IN || DEFAULT_PATH;
const outPath = process.env.GLOBAL_GEO_OUT || DEFAULT_PATH;

/**
 * Natural Earth 对台湾条目使用「中华民国」；产品展示统一为「台湾」。
 * @param {string} name 英文常用名
 * @param {string|null} nameZh
 * @returns {string|null}
 */
function normalizeNameZhForDisplay(name, nameZh) {
  if (name === "Taiwan") {
    return "台湾";
  }
  return nameZh;
}

/**
 * @param {Record<string, unknown>} p 原始 Natural Earth properties 或已精简字段
 */
function slimProperties(p) {
  if (p && typeof p.name === "string") {
    let nameZh =
      p.nameZh != null && String(p.nameZh).trim() !== "" ? p.nameZh : null;
    nameZh = normalizeNameZhForDisplay(p.name, nameZh);
    return {
      name: p.name,
      nameZh,
    };
  }

  const name = p.NAME ?? p.NAME_EN ?? p.ADMIN ?? "";
  const nameStr = typeof name === "string" ? name : String(name);
  let nameZh =
    p.NAME_ZH != null && String(p.NAME_ZH).trim() !== "" ? p.NAME_ZH : null;
  nameZh = normalizeNameZhForDisplay(nameStr, nameZh);
  return {
    name: nameStr,
    nameZh,
  };
}

function main() {
  const raw = fs.readFileSync(inPath, "utf8");
  const inputBytes = Buffer.byteLength(raw, "utf8");
  const data = JSON.parse(raw);
  if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("输入不是有效的 FeatureCollection");
  }

  const features = data.features.map((f) => {
    if (!f || f.type !== "Feature" || !f.geometry) {
      throw new Error("存在缺少 geometry 的要素");
    }
    return {
      type: "Feature",
      properties: slimProperties(f.properties || {}),
      geometry: f.geometry,
    };
  });

  const output = {
    type: "FeatureCollection",
    name: "ne_50m_admin_0_countries_slim",
    features,
  };

  const outJson = JSON.stringify(output);
  fs.writeFileSync(outPath, outJson, "utf8");
  const outputBytes = Buffer.byteLength(outJson, "utf8");

  console.log(
    `完成: ${features.length} 个要素\n` +
      `  输入: ${inPath} (${inputBytes} bytes)\n` +
      `  输出: ${outPath} (${outputBytes} bytes)\n` +
      `  体积减少: ${((1 - outputBytes / inputBytes) * 100).toFixed(1)}%`,
  );
}

main();
