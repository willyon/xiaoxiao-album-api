/*
 * @Description: 音频处理服务 - 元数据提取（ffprobe）、Chrome 兼容转码（ALAC→AAC）
 * 依赖：系统需安装 ffprobe、ffmpeg
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");

const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

/** Chrome 不支持的编码（Safari 支持），需转码为 AAC */
const CHROME_UNSUPPORTED_CODECS = ["alac"];

/** 合理录制时间下限（过滤 1970-01-01 等无效默认值） */
const MIN_VALID_TIMESTAMP = new Date("1971-01-01").getTime();

/**
 * 解析 ISO 8601 或类似格式的 creation_time 为时间戳（毫秒）
 * 过滤明显无效的默认值（如 1970-01-01）
 */
function _parseCreationTime(str) {
  if (!str || typeof str !== "string") return null;
  try {
    const date = new Date(str);
    const ts = date.getTime();
    if (isNaN(ts) || ts < MIN_VALID_TIMESTAMP) return null;
    return ts;
  } catch {
    return null;
  }
}

/**
 * 从 tags 中按 key 获取值（不区分大小写，支持多种命名）
 */
function _getTag(tags, ...keys) {
  if (!tags || typeof tags !== "object") return null;
  const keyMap = {};
  for (const [k, v] of Object.entries(tags)) {
    keyMap[k.toLowerCase()] = v;
  }
  for (const key of keys) {
    const val = keyMap[key.toLowerCase()];
    if (val != null && val !== "") return val;
  }
  return null;
}

/**
 * 解析 MP3 ID3v2.3 的 TYER+TDAT+TIME 组合为时间戳
 * TYER=YYYY, TDAT=MMDD, TIME=HHMM
 */
function _parseId3v23Date(tyer, tdat, time) {
  if (!tyer || typeof tyer !== "string") return null;
  const year = tyer.trim();
  if (year.length !== 4 || !/^\d{4}$/.test(year)) return null;
  let month = "01";
  let day = "01";
  if (tdat && typeof tdat === "string" && tdat.length >= 4) {
    const m = tdat.slice(0, 2);
    const d = tdat.slice(2, 4);
    if (/^\d{2}$/.test(m) && /^\d{2}$/.test(d)) {
      month = m;
      day = d;
    }
  }
  let hour = "00";
  let min = "00";
  if (time && typeof time === "string" && time.length >= 4) {
    const h = time.slice(0, 2);
    const m = time.slice(2, 4);
    if (/^\d{2}$/.test(h) && /^\d{2}$/.test(m)) {
      hour = h;
      min = m;
    }
  }
  const isoStr = `${year}-${month}-${day}T${hour}:${min}:00`;
  return _parseCreationTime(isoStr);
}

/**
 * 使用 ffprobe 获取音频元数据
 * @param {string} audioPath - 音频文件路径
 * @returns {Promise<Object>} { duration, codec, creationTime, gpsLatitude?, gpsLongitude? }
 */
async function getAudioMetadata(audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      audioPath,
    ];

    const proc = spawn(FFPROBE_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", () => {});

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const result = _parseFfprobeOutput(data);
        resolve(result);
      } catch (err) {
        reject(new Error(`ffprobe parse failed: ${err.message}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`ffprobe spawn failed: ${err.message}`));
    });
  });
}

/**
 * 解析 ISO 6709 格式的 GPS 字符串（如 +39.9042+116.4074/）
 * M4A/MP4 format.tags.location 或 stream.tags.location
 */
function _parseGpsIso6709(str) {
  if (!str || typeof str !== "string") return null;
  const match = str.match(/^([+-]?\d+\.?\d*)([+-]?\d+\.?\d*)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * 解析 FLAC/Vorbis LOCATION、MP3 自定义等文本坐标
 * 支持："40.7128,-74.0060"、"40.7128 -74.0060"、"LL@44.734,-74.339"
 */
function _parseGpsFromText(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  let match = trimmed.match(/^LL@\s*([+-]?\d+\.?\d*)\s*[,，]\s*([+-]?\d+\.?\d*)$/i);
  if (!match) {
    match = trimmed.match(/^([+-]?\d+\.?\d*)\s*[,，\s]\s*([+-]?\d+\.?\d*)$/);
  }
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * 从 tags 中提取 GPS
 * - M4A/MP4：format/stream 的 location（ISO 6709）
 * - FLAC：LOCATION 文本（lat,lon 或 LL@lat,lon）
 */
function _extractGpsFromTags(formatTags, streamTags) {
  const locStr = _getTag(formatTags, "location") || _getTag(streamTags, "location");
  if (locStr) {
    const loc = _parseGpsIso6709(locStr);
    if (loc) return loc;
  }
  const locText = _getTag(formatTags, "LOCATION");
  if (locText) {
    const loc = _parseGpsFromText(locText);
    if (loc) return loc;
  }
  return null;
}

/**
 * 解析 ffprobe JSON 输出（音频）
 * 录制时间来源（按优先级）：
 * 1. stream.tags.creation_time - M4A/MP4 流级
 * 2. format.tags.creation_time - 容器级
 * 3. format.tags.com.apple.quicktime.creationdate - QuickTime/M4A
 * 4. format.tags.TDRC - MP3 ID3v2.4 录制时间（ISO 8601）
 * 5. format.tags.TYER+TDAT+TIME - MP3 ID3v2.3 年月日时分
 * 6. format.tags.date / DATE - FLAC Vorbis comment、部分 WAV
 * 7. format.tags.creation_date - 部分格式
 */
function _parseFfprobeOutput(data) {
  const result = {
    duration: null,
    codec: null,
    creationTime: null,
    gpsLatitude: null,
    gpsLongitude: null,
  };

  if (data.format && data.format.duration) {
    result.duration = parseFloat(data.format.duration);
  }

  const formatTags = data.format?.tags || {};
  const streamTags = data.streams?.find((s) => s.codec_type === "audio")?.tags || {};

  // 1. 流级 creation_time（M4A/MP4）
  let ct = _getTag(streamTags, "creation_time");
  if (ct) result.creationTime = _parseCreationTime(ct);

  // 2-3. 容器级 creation_time、com.apple.quicktime.creationdate
  if (!result.creationTime) {
    ct = _getTag(formatTags, "creation_time", "com.apple.quicktime.creationdate");
    if (ct) result.creationTime = _parseCreationTime(ct);
  }

  // 4. MP3 ID3v2.4 TDRC（ISO 8601）
  if (!result.creationTime) {
    ct = _getTag(formatTags, "TDRC", "tdrc");
    if (ct) result.creationTime = _parseCreationTime(ct);
  }

  // 5. MP3 ID3v2.3 TYER+TDAT+TIME
  if (!result.creationTime) {
    const tyer = _getTag(formatTags, "TYER", "tyer");
    const tdat = _getTag(formatTags, "TDAT", "tdat");
    const time = _getTag(formatTags, "TIME", "time");
    if (tyer) {
      result.creationTime = _parseId3v23Date(tyer, tdat, time);
    }
  }

  // 6. FLAC/Vorbis date、部分格式的 date
  if (!result.creationTime) {
    ct = _getTag(formatTags, "date", "DATE");
    if (ct) {
      const parsed = _parseCreationTime(ct);
      if (parsed) result.creationTime = parsed;
    }
  }

  // 7. creation_date 等变体
  if (!result.creationTime) {
    ct = _getTag(formatTags, "creation_date", "creationdate");
    if (ct) result.creationTime = _parseCreationTime(ct);
  }

  // 取 codec
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  if (audioStream) {
    result.codec = audioStream.codec_name || null;
  }

  // GPS：location（M4A/MP4 ISO 6709）、FLAC LOCATION 文本
  const gps = _extractGpsFromTags(formatTags, streamTags);
  if (gps) {
    result.gpsLatitude = gps.latitude;
    result.gpsLongitude = gps.longitude;
  }

  return result;
}

/**
 * 若编码为 Chrome 不支持的格式（如 ALAC），则转码为 AAC，便于 Chrome 播放
 * @param {string} audioPath - 音频文件绝对路径
 * @param {string} codec - ffprobe 返回的 codec_name（如 'alac', 'aac'）
 * @returns {Promise<boolean>} 是否执行了转码
 */
async function transcodeToAacIfNeeded(audioPath, codec) {
  const codecLower = (codec || "").toLowerCase();
  if (!CHROME_UNSUPPORTED_CODECS.includes(codecLower)) {
    return false;
  }

  const ext = path.extname(audioPath);
  const tempPath = path.join(os.tmpdir(), `audio-transcode-${Date.now()}${ext}`);

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      audioPath,
      "-map_metadata",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tempPath,
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg transcode failed with code ${code}: ${stderr.slice(-300)}`));
        return;
      }
      try {
        await fs.copyFile(tempPath, audioPath);
        await fs.unlink(tempPath);
        resolve(true);
      } catch (err) {
        try {
          await fs.unlink(tempPath);
        } catch {}
        reject(err);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
  });
}

module.exports = {
  getAudioMetadata,
  transcodeToAacIfNeeded,
};
