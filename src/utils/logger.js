const fs = require("fs");
const path = require("path");
const { format } = require("date-fns");
require("dotenv").config();

// 从 .env 文件中读取日志目录路径
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "..", "..", "logs");

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 获取当天的日志文件路径
function getLogFilePath() {
  const date = format(new Date(), "yyyy-MM-dd");
  return path.join(LOG_DIR, `error-${date}.log`);
}

// 创建日志流（按天切分）
let logStream = null;
function getLogStream() {
  const logFilePath = getLogFilePath();
  if (!logStream || logStream.path !== logFilePath) {
    if (logStream) logStream.end(); // 关闭旧的日志流
    logStream = fs.createWriteStream(logFilePath, { flags: "a" }); // 追加写入模式
    logStream.on("error", (err) => {
      console.error("Log stream error:", err); // 写入流写入过程中出错，捕获错误并记录
    });
  }
  return logStream;
}

// 格式化日志信息
function formatLogMessage({ timestamp, level, message, stack, requestInfo }) {
  return [
    `[${timestamp}] [${level.toUpperCase()}] ${message}`,
    requestInfo ? `Request Info: ${JSON.stringify(requestInfo)}` : null,
    stack ? `Stack Trace: ${stack}` : null,
    "\n",
  ]
    .filter(Boolean)
    .join("\n");
}

// 写入日志
function logToFile(logMessage) {
  const stream = getLogStream();
  stream.write(logMessage + "\n"); // 异步写入日志
}

// 日志工具函数
function logError({ message, stack, requestInfo }) {
  const timestamp = format(new Date(), "yyyy-MM-dd HH:mm:ss");
  const logMessage = formatLogMessage({
    timestamp,
    level: "error",
    message,
    stack,
    requestInfo,
  });

  // 写入文件
  logToFile(logMessage);

  // 打印到控制台（可选）
  console.error(logMessage);
}

module.exports = { logError };
