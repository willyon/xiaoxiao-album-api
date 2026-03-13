/*
 * @Author: zhangshouchang
 * @Date: 2025-01-08
 * @Description: OSS回调相关工具（URL构建、签名验证等）
 */
const crypto = require("crypto");
const https = require("https");
const logger = require("./logger");
const CustomError = require("../errors/customError");

// OSS回调验证配置
const OSS_CALLBACK_CONFIG = {
  // 验证级别：'none' | 'light' | 'full'
  VERIFICATION_LEVEL: process.env.OSS_CALLBACK_VERIFICATION_LEVEL || "light",
  // 时间窗口（秒）
  MAX_AGE_SECONDS: parseInt(process.env.OSS_CALLBACK_MAX_AGE_SECONDS) || 600, // 10分钟
  // 公钥缓存时间（秒）
  PUBLIC_KEY_CACHE_SECONDS: parseInt(process.env.OSS_PUBLIC_KEY_CACHE_SECONDS) || 86400, // 24小时
};

// 公钥缓存
let publicKeyCache = {
  key: null,
  timestamp: 0,
};

/**
 * 检查请求时间是否有效（防重放攻击）
 *
 * 检查请求的date头是否在允许的时间窗口内
 * 防止攻击者重放旧的请求
 *
 * @param {string} dateHeader - HTTP Date头值
 * @returns {boolean} 时间是否有效
 */
function _isRequestTimestampValid(dateHeader) {
  try {
    const requestTime = new Date(dateHeader);
    const now = new Date();
    const timeDiff = Math.abs(now - requestTime) / 1000; // 秒

    // 检查时间差是否在允许范围内
    if (timeDiff > OSS_CALLBACK_CONFIG.MAX_AGE_SECONDS) {
      logger.warn({
        message: "Request timestamp too old, possible replay attack",
        details: {
          requestTime: dateHeader,
          currentTime: now.toISOString(),
          timeDiff: Math.round(timeDiff),
          maxAge: OSS_CALLBACK_CONFIG.MAX_AGE_SECONDS,
        },
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.error({
      message: "Invalid date header format",
      details: {
        dateHeader,
        error: error.message,
      },
    });
    return false;
  }
}

/**
 * 解码Base64编码的URL
 *
 * 将OSS回调中的Base64编码公钥URL解码为可用的URL
 *
 * @param {string} encodedUrl - Base64 编码的 URL
 * @returns {string|null} 解码后的 URL，无效时返回null
 */
function _decodeUrl(encodedUrl) {
  const decodedUrl = Buffer.from(encodedUrl, "base64").toString("utf-8");

  // 验证公钥 URL 是否合法
  if (!decodedUrl.startsWith("http://gosspublic.alicdn.com/") && !decodedUrl.startsWith("https://gosspublic.alicdn.com/")) {
    logger.error({
      message: "Invalid public key URL",
      details: { decodedUrl },
    });
    return null;
  }

  return decodedUrl;
}

/**
 * 获取缓存的公钥
 *
 * 检查公钥缓存是否有值且未过期
 *
 * @returns {string|null} 缓存的公钥，无效时返回null
 */
function _getCachedPublicKey() {
  const now = Date.now();
  const cacheAge = (now - publicKeyCache.timestamp) / 1000; // 秒

  // 检查缓存是否有效
  if (publicKeyCache.key && cacheAge < OSS_CALLBACK_CONFIG.PUBLIC_KEY_CACHE_SECONDS) {
    return publicKeyCache.key;
  }

  return null;
}

/**
 * 从OSS公钥URL获取公钥（带缓存）
 *
 * 从OSS提供的公钥URL获取RSA公钥，用于验证回调签名
 * 支持HTTPS协议，自动解析JSON响应格式，并缓存公钥以提高性能
 *
 * @param {string} pubKeyUrl - 公钥URL地址
 * @returns {Promise<string>} 公钥内容（PEM格式）
 * @throws {Error} 当获取公钥失败时抛出错误
 */
async function _fetchPublicKeyWithCache(pubKeyUrl) {
  try {
    const publicKey = await _fetchPublicKey(pubKeyUrl);

    // 更新缓存
    const now = Date.now();
    publicKeyCache.key = publicKey;
    publicKeyCache.timestamp = now;

    return publicKey;
  } catch (error) {
    logger.error({
      message: "OSS公钥获取失败",
      details: {
        pubKeyUrl,
        error: error.message,
      },
    });
    throw error;
  }
}

/**
 * 从OSS公钥URL获取公钥（原始方法）
 *
 * 从OSS提供的公钥URL获取RSA公钥，用于验证回调签名
 * 支持HTTPS协议，自动解析JSON响应格式
 *
 * @param {string} pubKeyUrl - 公钥URL地址
 * @returns {Promise<string>} 公钥内容（PEM格式）
 * @throws {Error} 当获取公钥失败时抛出错误
 */
async function _fetchPublicKey(pubKeyUrl) {
  return new Promise((resolve, reject) => {
    https
      .get(pubKeyUrl, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (data && data.trim()) {
            resolve(data.trim());
          } else {
            reject(new Error("Empty public key response"));
          }
        });
      })
      .on("error", (error) => {
        reject(new Error(`Failed to fetch public key: ${error.message}`));
      });
  });
}

/**
 * OSS回调验证（支持多种验证级别）
 *
 * 根据配置选择不同的验证级别，平衡安全性和性能
 *
 * @param {Object} req - Express请求对象
 * @returns {Promise<boolean>} 验证结果
 *
 * 验证级别：
 * - 'none': 不进行任何验证（最高性能，最低安全）
 * - 'light': 轻量级验证（仅基本Header检查，适合小规模应用）
 * - 'full': 完整验证（包含时间窗口 + 公钥签名验证）
 */
async function verifyOSSCallbackSignature(req) {
  const { VERIFICATION_LEVEL } = OSS_CALLBACK_CONFIG;

  try {
    // 无验证模式：直接通过（仅用于开发/测试）
    if (VERIFICATION_LEVEL === "none") {
      logger.info({
        message: "OSS回调验证跳过（无验证模式）",
        details: { verificationLevel: VERIFICATION_LEVEL },
      });
      return true;
    }

    const pubKeyUrl = req.headers["x-oss-pub-key-url"];
    const authorization = req.headers["authorization"];
    const contentMd5 = req.headers["content-md5"];
    const contentType = req.headers["content-type"];
    const date = req.headers["date"];

    // 轻量级和完整验证都需要的基本检查
    if (VERIFICATION_LEVEL === "light" || VERIFICATION_LEVEL === "full") {
      // 1. 基本Header存在性检查
      if (!pubKeyUrl || !authorization || !contentMd5 || !contentType || !date) {
        logger.warn({
          message: "Missing required OSS callback headers",
          details: {
            pubKeyUrl: !!pubKeyUrl,
            authorization: !!authorization,
            contentMd5: !!contentMd5,
            contentType: !!contentType,
            date: !!date,
          },
        });
        return false;
      }
    }

    // 轻量级验证：到此结束
    if (VERIFICATION_LEVEL === "light") {
      logger.info({
        message: "OSS回调轻量级验证通过",
        details: {
          verificationLevel: VERIFICATION_LEVEL,
          hasRequiredHeaders: true,
          note: "Skipped timestamp and signature verification for performance",
        },
      });
      return true;
    }

    // 完整验证：时间窗口检查 + 公钥签名验证
    if (VERIFICATION_LEVEL === "full") {
      // 1. 时间窗口检查（防重放攻击）
      if (!_isRequestTimestampValid(date)) {
        return false;
      }

      // 2. 公钥签名验证
      // 先检查公钥缓存是否有值且未过期
      let publicKey = await _getCachedPublicKey();

      // 如果公钥缓存无效，才去解码URL并获取公钥
      if (!publicKey) {
        const decodedPubKeyUrl = _decodeUrl(pubKeyUrl);

        // 检查公钥 URL 是否合法
        if (!decodedPubKeyUrl) {
          return false;
        }

        // 获取公钥（带缓存）
        publicKey = await _fetchPublicKeyWithCache(decodedPubKeyUrl);
      }

      // 构建待签名字符串
      const stringToSign = _buildStringToSign(req);

      // 验证签名 - 按照官方Node.js实现：使用RSA-MD5算法
      // 解码authorization签名
      const signature = Buffer.from(authorization, "base64");

      // 使用RSA-MD5算法验证签名（按照官方Node.js实现）
      const verifier = crypto.createVerify("RSA-MD5");
      verifier.update(stringToSign);
      const isValid = verifier.verify(publicKey, signature);

      // 只在验证失败时记录错误日志
      if (!isValid) {
        logger.error({
          message: "OSS回调签名验证失败",
          details: {
            verificationLevel: VERIFICATION_LEVEL,
            pubKeyUrl,
            stringToSign: stringToSign,
            authorization: authorization,
          },
        });
      }

      return isValid;
    }

    // 未知验证级别
    logger.error({
      message: "Unknown verification level",
      details: { verificationLevel: VERIFICATION_LEVEL },
    });
    return false;
  } catch (error) {
    logger.error({
      message: "OSS回调验证异常",
      details: {
        error: error.message,
        verificationLevel: VERIFICATION_LEVEL,
      },
    });
    return false;
  }
}

/**
 * 构建待签名字符串
 *
 * 根据阿里云OSS回调签名规范构建待验证的字符串
 * 格式：url_decode(path) + query_string + '\n' + body
 *
 * @param {Object} req - Express请求对象
 * @returns {string} 待签名字符串
 *
 * 注意：严格按照阿里云OSS官方文档的签名规范实现
 */
function _buildStringToSign(req) {
  // 返回url的路径部分 如 /aliyunOss/mediaUploadCallback
  const path = req.originalUrl;

  //返回url的查询参数部分 为空时返回一个空对象{} req.query = { userId: '123', storageKey: '123.jpg' } 需要通过new URLSearchParams(req.query).toString() 转换为字符串
  const hasQuery = req.query && Object.keys(req.query).length;
  const queryString = hasQuery ? `?${new URLSearchParams(req.query).toString()}` : "";

  // 构建请求体字符串
  const bodyString = req.body ? JSON.stringify(req.body) : "";

  // 按照官方Node.js实现构建待签名字符串
  // 格式：decodeURIComponent(path) + queryString + '\n' + body
  // 按OSS签名规范，path需URL解码；无编码时结果不变，有编码时可还原原始字符
  const stringToSign = decodeURIComponent(path) + queryString + "\n" + bodyString;

  return stringToSign;
}

/**
 * 构建OSS回调URL
 *
 * 根据环境变量或请求对象生成完整的OSS回调URL
 * 用于OSS直传时的callback参数配置
 *
 * @param {Object} req - Express请求对象（可选，用于兜底方案）
 * @returns {string} 回调URL
 *
 * 环境变量优先级：
 * 1. NGROK_URL (开发环境)
 * 2. API_BASE_URL_ALIYUN_ECS (生产环境)
 * 3. 从请求对象构建 (兜底方案)
 * 4. 抛出错误 (无配置)
 */
function buildOSSCallbackUrl(req = null) {
  // 根据环境自动选择
  if (process.env.NODE_ENV === "development") {
    return `${process.env.NGROK_URL}/aliyunOss/mediaUploadCallback`;
  }

  // 生产环境使用 API_BASE_URL_ALIYUN_ECS
  if (process.env.API_BASE_URL_ALIYUN_ECS) {
    return `${process.env.API_BASE_URL_ALIYUN_ECS}/aliyunOss/mediaUploadCallback`;
  }

  // 兜底方案：使用请求的完整URL（仅在提供req参数时）
  if (req) {
    return `${req.protocol}://${req.get("host")}/aliyunOss/mediaUploadCallback`;
  }

  // 如果都没有配置，抛出错误
  throw new Error("无法构建OSS回调URL：请配置NGROK_URL或API_BASE_URL_ALIYUN_ECS环境变量");
}

/**
 * 解析OSS回调数据
 * @param {Object} body - 请求体
 * @returns {Object} 解析后的数据
 * @throws {CustomError} 数据无效时抛出错误
 */
function parseCallbackData(body) {
  // OSS回调数据格式：JSON格式 {storageKey, fileSize, userId, imageHash}
  let callbackData;

  // 如果body是字符串，尝试解析JSON
  if (typeof body === "string") {
    try {
      callbackData = JSON.parse(body);
    } catch (error) {
      throw new CustomError({
        httpStatus: 400,
        message: "Invalid JSON callback data",
        details: { body, error: error.message },
      });
    }
  } else {
    callbackData = body;
  }

  const { storageKey, fileSize, userId, imageHash, sessionId } = callbackData;

  if (!userId || !imageHash || !storageKey) {
    throw new CustomError({
      httpStatus: 400,
      message: "Invalid callback data",
      details: {
        callbackData,
        requiredFields: ["userId", "imageHash", "storageKey"],
      },
    });
  }

  // 生成文件名（保持完整路径结构，只提取相对路径部分）
  // storageKey 格式：images/id/xxx/xxx/image.ext
  // fileName 格式：id/xxx/xxx/image.ext（去掉开头的 images/）
  const fileName = storageKey.startsWith("images/")
    ? storageKey.substring(7) // 去掉 'images/' 前缀
    : storageKey; // 如果不是 images/ 开头，保持原样

  return {
    storageKey,
    fileSize: parseInt(fileSize),
    userId,
    hash: imageHash, // 统一使用 hash 字段名
    fileName,
    sessionId, // 传递会话ID
  };
}

module.exports = {
  // 主要接口
  verifyOSSCallbackSignature, // OSS回调签名验证
  buildOSSCallbackUrl, // 构建OSS回调URL
  parseCallbackData, // 解析OSS回调数据
};
