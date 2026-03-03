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
