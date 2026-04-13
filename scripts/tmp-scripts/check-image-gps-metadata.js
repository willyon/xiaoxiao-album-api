/*
 * @Description: 解析图片/视频元数据，判断是否包含 GPS（经纬度）以及是否有可用的拍摄/时间类信息。
 * 解析策略与 src/services/mediaMetadataService.js 对齐：先 exifr（仅静态图），再按需 exiftool。
 *
 * 时间字段优先级（与业务「拍摄时间」接近者优先）：DateTimeOriginal → CreateDate → DateTimeDigitized → ModifyDate
 * （仅统计嵌入元数据中的时间；不含操作系统「文件修改时间」等）
 *
 * @Usage（在 xiaoxiao-project-service 目录下执行）:
 *   node scripts/tmp-scripts/check-image-gps-metadata.js
 *   node scripts/tmp-scripts/check-image-gps-metadata.js /path/a.jpg /path/b.mp4
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const exifr = require("exifr");
const { exiftool } = require("exiftool-vendored");

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

const { stringToTimestamp } = require(path.join(projectRoot, "src", "utils", "formatTime"));

const DEFAULT_IMAGE = path.join(projectRoot, "localStorage", "processed", "original", "1-20260412-102141-8a45a87bde9c.jpg");

/** 与 mediaMetadataService._standardizeMetadata 中 GPS 相关字段对齐 */
function pickGpsFromRaw(rawData) {
  if (!rawData || typeof rawData !== "object") return {};

  const n = (v) => {
    if (v == null) return undefined;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "object" && "value" in v && typeof v.value === "number") return v.value;
    return undefined;
  };

  const out = {};

  if (rawData.latitude !== undefined) out.latitude = n(rawData.latitude) ?? rawData.latitude;
  else if (rawData.GPSLatitude !== undefined) out.latitude = n(rawData.GPSLatitude);

  if (rawData.longitude !== undefined) out.longitude = n(rawData.longitude) ?? rawData.longitude;
  else if (rawData.GPSLongitude !== undefined) out.longitude = n(rawData.GPSLongitude);

  if (rawData.GPSAltitude !== undefined) out.altitude = n(rawData.GPSAltitude);

  return out;
}

/** 单字段 → 毫秒时间戳；与 _standardizeMetadata 中 DateTimeOriginal 处理一致 */
function fieldToMillis(fieldName, rawData) {
  const v = rawData[fieldName];
  if (v == null) return null;

  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof v === "object" && v.rawValue != null) {
    const ms = stringToTimestamp(String(v.rawValue));
    return ms == null || Number.isNaN(ms) ? null : ms;
  }
  if (typeof v === "string") {
    const ms = stringToTimestamp(v);
    return ms == null || Number.isNaN(ms) ? null : ms;
  }
  if (typeof v === "number" && !Number.isNaN(v)) {
    return v;
  }
  return null;
}

const TIME_FIELD_ORDER = ["DateTimeOriginal", "CreateDate", "DateTimeDigitized", "ModifyDate"];

/**
 * 从原始元数据中取「第一条能解析成功」的时间；返回毫秒时间戳与字段名。
 */
function pickTimeFromRaw(rawData) {
  if (!rawData || typeof rawData !== "object") return { captureTimeMs: null, timeField: null };

  for (const name of TIME_FIELD_ORDER) {
    const ms = fieldToMillis(name, rawData);
    if (ms != null) {
      return { captureTimeMs: ms, timeField: name };
    }
  }
  return { captureTimeMs: null, timeField: null };
}

function hasValidLatLng(gps) {
  return (
    gps &&
    typeof gps.latitude === "number" &&
    typeof gps.longitude === "number" &&
    !Number.isNaN(gps.latitude) &&
    !Number.isNaN(gps.longitude)
  );
}

function hasValidTime(t) {
  return t && typeof t.captureTimeMs === "number" && !Number.isNaN(t.captureTimeMs);
}

/**
 * 合并 exifr + 按需 exiftool：缺 GPS 或缺时间时调用 exiftool 再合并。
 */
async function extractMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);
  let tempFilePath = null;
  const trace = { exifr: null, exiftool: null };

  let mergedGps = {};
  let mergedTime = { captureTimeMs: null, timeField: null };

  try {
    try {
      const data = await exifr.parse(buffer, {
        exif: true,
        tiff: true,
        gps: true,
        xmp: true,
        icc: false,
        iptc: false,
      });
      trace.exifr = data && Object.keys(data).length > 0 ? `ok (${Object.keys(data).length} keys)` : "empty";
      if (data && Object.keys(data).length > 0) {
        mergedGps = { ...mergedGps, ...pickGpsFromRaw(data) };
        const t = pickTimeFromRaw(data);
        if (hasValidTime(t)) mergedTime = t;
      }
    } catch (e) {
      trace.exifr = `error: ${e.message}`;
    }

    const needExiftool = !hasValidLatLng(mergedGps) || !hasValidTime(mergedTime);

    if (needExiftool) {
      try {
        let exiftoolData;
        if (filePath) {
          exiftoolData = await exiftool.read(filePath);
        } else {
          const unique = `${Date.now()}_${randomUUID()}`;
          tempFilePath = path.join(os.tmpdir(), `check_meta_${unique}.tmp`);
          fs.writeFileSync(tempFilePath, buffer);
          exiftoolData = await exiftool.read(tempFilePath);
        }
        trace.exiftool =
          exiftoolData && Object.keys(exiftoolData).length > 0 ? `ok (${Object.keys(exiftoolData).length} keys)` : "empty";
        mergedGps = { ...mergedGps, ...pickGpsFromRaw(exiftoolData) };
        const tEt = pickTimeFromRaw(exiftoolData);
        if (hasValidTime(tEt)) {
          if (!hasValidTime(mergedTime)) mergedTime = tEt;
          else if (TIME_FIELD_ORDER.indexOf(tEt.timeField) < TIME_FIELD_ORDER.indexOf(mergedTime.timeField)) {
            mergedTime = tEt;
          }
        }
      } catch (e) {
        trace.exiftool = `error: ${e.message}`;
      }
    }

    return { mergedGps, mergedTime, trace };
  } finally {
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function formatIso(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
}

async function analyzeOne(imagePath) {
  const { mergedGps, mergedTime, trace } = await extractMetadata(imagePath);
  const hasGeo = hasValidLatLng(mergedGps);
  const hasTime = hasValidTime(mergedTime);

  return {
    file: imagePath,
    containsGeolocation: hasGeo,
    latitude: mergedGps.latitude ?? null,
    longitude: mergedGps.longitude ?? null,
    altitude: mergedGps.altitude ?? null,
    containsTimeInformation: hasTime,
    timeField: mergedTime.timeField,
    captureTimeMs: hasTime ? mergedTime.captureTimeMs : null,
    captureTimeIso: hasTime ? formatIso(mergedTime.captureTimeMs) : null,
    parseTrace: trace,
  };
}

function printHumanSummary(r) {
  const lines = [];
  lines.push(r.containsGeolocation ? "· 地理位置（GPS）：有" : "· 地理位置（GPS）：无");
  lines.push(
    r.containsTimeInformation
      ? `· 时间信息：有（字段 ${r.timeField}，ISO ${r.captureTimeIso}）`
      : "· 时间信息：无（未解析到 DateTimeOriginal / CreateDate / DateTimeDigitized / ModifyDate）",
  );
  return lines.join("\n");
}

async function main() {
  const paths =
    process.argv.length > 2 ? process.argv.slice(2).map((p) => path.resolve(p)) : [DEFAULT_IMAGE];

  for (let i = 0; i < paths.length; i++) {
    const imagePath = paths[i];
    if (!fs.existsSync(imagePath)) {
      console.error("文件不存在:", imagePath);
      process.exitCode = 1;
      continue;
    }

    const report = await analyzeOne(imagePath);
    console.log(JSON.stringify(report, null, 2));
    console.log("");
    console.log(printHumanSummary(report));
    if (i < paths.length - 1) console.log("\n---\n");
  }

  await exiftool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await exiftool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
