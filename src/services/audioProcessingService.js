/*
 * @Description: 音频处理服务 - 元数据提取（ffprobe）
 * 依赖：系统需安装 ffprobe
 */
const { spawn } = require("child_process");

const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

/**
 * 解析 ISO 8601 或类似格式的 creation_time 为时间戳（毫秒）
 */
function _parseCreationTime(str) {
  if (!str || typeof str !== "string") return null;
  try {
    const date = new Date(str);
    return isNaN(date.getTime()) ? null : date.getTime();
  } catch {
    return null;
  }
}

/**
 * 使用 ffprobe 获取音频元数据
 * @param {string} audioPath - 音频文件路径
 * @returns {Promise<Object>} { duration, codec, creationTime }
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
 * 解析 ffprobe JSON 输出（音频）
 */
function _parseFfprobeOutput(data) {
  const result = {
    duration: null,
    codec: null,
    creationTime: null,
  };

  if (data.format && data.format.duration) {
    result.duration = parseFloat(data.format.duration);
  }

  // 取第一个 audio 流
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  if (audioStream) {
    result.codec = audioStream.codec_name || null;
    if (audioStream.tags?.creation_time) {
      result.creationTime = _parseCreationTime(audioStream.tags.creation_time);
    }
  }

  if (!result.creationTime && data.format?.tags) {
    const tags = data.format.tags;
    const ct = tags.creation_time || tags["com.apple.quicktime.creationdate"];
    if (ct) {
      result.creationTime = _parseCreationTime(ct);
    }
  }

  return result;
}

module.exports = {
  getAudioMetadata,
};
