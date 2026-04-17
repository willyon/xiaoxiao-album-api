/*
 * @Author: zhangshouchang
 * @Date: 2025-01-08
 * @Description: 阿里云 OSS 服务端工具：直传策略签名、回调 URL/验签/解析等
 */
const crypto = require('crypto')
const https = require('https')
const logger = require('./logger')
const CustomError = require('../errors/customError')

/**
 * 生成 OSS 上传策略签名（PostObject / 表单上传 policy 的 Base64 串）
 * @param {string} policyString - 策略字符串（已 Base64 编码）
 * @param {string} accessKeySecret - 访问密钥
 * @returns {string} 策略签名
 */
function generatePolicySignature(policyString, accessKeySecret) {
  if (!accessKeySecret) {
    throw new Error('AccessKeySecret is required for policy signature generation')
  }
  return crypto.createHmac('sha1', accessKeySecret).update(policyString).digest('base64')
}

// OSS 回调验证配置
const OSS_CALLBACK_CONFIG = {
  VERIFICATION_LEVEL: process.env.OSS_CALLBACK_VERIFICATION_LEVEL || 'light',
  MAX_AGE_SECONDS: parseInt(process.env.OSS_CALLBACK_MAX_AGE_SECONDS) || 600,
  PUBLIC_KEY_CACHE_SECONDS: parseInt(process.env.OSS_PUBLIC_KEY_CACHE_SECONDS) || 86400
}

let publicKeyCache = {
  key: null,
  timestamp: 0
}

function _isRequestTimestampValid(dateHeader) {
  try {
    const requestTime = new Date(dateHeader)
    const now = new Date()
    const timeDiff = Math.abs(now - requestTime) / 1000

    if (timeDiff > OSS_CALLBACK_CONFIG.MAX_AGE_SECONDS) {
      logger.warn({
        message: 'Request timestamp too old, possible replay attack',
        details: {
          requestTime: dateHeader,
          currentTime: now.toISOString(),
          timeDiff: Math.round(timeDiff),
          maxAge: OSS_CALLBACK_CONFIG.MAX_AGE_SECONDS
        }
      })
      return false
    }

    return true
  } catch (error) {
    logger.error({
      message: 'Invalid date header format',
      details: {
        dateHeader,
        error: error.message
      }
    })
    return false
  }
}

function _decodeUrl(encodedUrl) {
  const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8')

  if (!decodedUrl.startsWith('http://gosspublic.alicdn.com/') && !decodedUrl.startsWith('https://gosspublic.alicdn.com/')) {
    logger.error({
      message: 'Invalid public key URL',
      details: { decodedUrl }
    })
    return null
  }

  return decodedUrl
}

function _getCachedPublicKey() {
  const now = Date.now()
  const cacheAge = (now - publicKeyCache.timestamp) / 1000

  if (publicKeyCache.key && cacheAge < OSS_CALLBACK_CONFIG.PUBLIC_KEY_CACHE_SECONDS) {
    return publicKeyCache.key
  }

  return null
}

async function _fetchPublicKeyWithCache(pubKeyUrl) {
  try {
    const publicKey = await _fetchPublicKey(pubKeyUrl)

    const now = Date.now()
    publicKeyCache.key = publicKey
    publicKeyCache.timestamp = now

    return publicKey
  } catch (error) {
    logger.error({
      message: 'OSS公钥获取失败',
      details: {
        pubKeyUrl,
        error: error.message
      }
    })
    throw error
  }
}

async function _fetchPublicKey(pubKeyUrl) {
  return new Promise((resolve, reject) => {
    https
      .get(pubKeyUrl, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (data && data.trim()) {
            resolve(data.trim())
          } else {
            reject(new Error('Empty public key response'))
          }
        })
      })
      .on('error', (error) => {
        reject(new Error(`Failed to fetch public key: ${error.message}`))
      })
  })
}

async function verifyOSSCallbackSignature(req) {
  const { VERIFICATION_LEVEL } = OSS_CALLBACK_CONFIG

  try {
    if (VERIFICATION_LEVEL === 'none') {
      logger.info({
        message: 'OSS回调验证跳过（无验证模式）',
        details: { verificationLevel: VERIFICATION_LEVEL }
      })
      return true
    }

    const pubKeyUrl = req.headers['x-oss-pub-key-url']
    const authorization = req.headers['authorization']
    const contentMd5 = req.headers['content-md5']
    const contentType = req.headers['content-type']
    const date = req.headers['date']

    if (VERIFICATION_LEVEL === 'light' || VERIFICATION_LEVEL === 'full') {
      if (!pubKeyUrl || !authorization || !contentMd5 || !contentType || !date) {
        logger.warn({
          message: 'Missing required OSS callback headers',
          details: {
            pubKeyUrl: !!pubKeyUrl,
            authorization: !!authorization,
            contentMd5: !!contentMd5,
            contentType: !!contentType,
            date: !!date
          }
        })
        return false
      }
    }

    if (VERIFICATION_LEVEL === 'light') {
      logger.info({
        message: 'OSS回调轻量级验证通过',
        details: {
          verificationLevel: VERIFICATION_LEVEL,
          hasRequiredHeaders: true,
          note: 'Skipped timestamp and signature verification for performance'
        }
      })
      return true
    }

    if (VERIFICATION_LEVEL === 'full') {
      if (!_isRequestTimestampValid(date)) {
        return false
      }

      let publicKey = await _getCachedPublicKey()

      if (!publicKey) {
        const decodedPubKeyUrl = _decodeUrl(pubKeyUrl)

        if (!decodedPubKeyUrl) {
          return false
        }

        publicKey = await _fetchPublicKeyWithCache(decodedPubKeyUrl)
      }

      const stringToSign = _buildStringToSign(req)

      const signature = Buffer.from(authorization, 'base64')

      const verifier = crypto.createVerify('RSA-MD5')
      verifier.update(stringToSign)
      const isValid = verifier.verify(publicKey, signature)

      if (!isValid) {
        logger.error({
          message: 'OSS回调签名验证失败',
          details: {
            verificationLevel: VERIFICATION_LEVEL,
            pubKeyUrl,
            stringToSign: stringToSign,
            authorization: authorization
          }
        })
      }

      return isValid
    }

    logger.error({
      message: 'Unknown verification level',
      details: { verificationLevel: VERIFICATION_LEVEL }
    })
    return false
  } catch (error) {
    logger.error({
      message: 'OSS回调验证异常',
      details: {
        error: error.message,
        verificationLevel: VERIFICATION_LEVEL
      }
    })
    return false
  }
}

function _buildStringToSign(req) {
  const path = req.originalUrl

  const hasQuery = req.query && Object.keys(req.query).length
  const queryString = hasQuery ? `?${new URLSearchParams(req.query).toString()}` : ''

  const bodyString = req.body ? JSON.stringify(req.body) : ''

  const stringToSign = decodeURIComponent(path) + queryString + '\n' + bodyString

  return stringToSign
}

function buildOSSCallbackUrl(req = null) {
  if (process.env.NODE_ENV === 'development') {
    return `${process.env.NGROK_URL}/aliyunOss/mediaUploadCallback`
  }

  if (process.env.API_BASE_URL_ALIYUN_ECS) {
    return `${process.env.API_BASE_URL_ALIYUN_ECS}/aliyunOss/mediaUploadCallback`
  }

  if (req) {
    return `${req.protocol}://${req.get('host')}/aliyunOss/mediaUploadCallback`
  }

  throw new Error('无法构建OSS回调URL：请配置NGROK_URL或API_BASE_URL_ALIYUN_ECS环境变量')
}

function parseCallbackData(body) {
  let callbackData

  if (typeof body === 'string') {
    try {
      callbackData = JSON.parse(body)
    } catch (error) {
      throw new CustomError({
        httpStatus: 400,
        message: 'Invalid JSON callback data',
        details: { body, error: error.message }
      })
    }
  } else {
    callbackData = body
  }

  const { storageKey, fileSize, userId, imageHash, sessionId } = callbackData

  if (!userId || !imageHash || !storageKey) {
    throw new CustomError({
      httpStatus: 400,
      message: 'Invalid callback data',
      details: {
        callbackData,
        requiredFields: ['userId', 'imageHash', 'storageKey']
      }
    })
  }

  const fileName = storageKey.startsWith('images/') ? storageKey.substring(7) : storageKey

  return {
    storageKey,
    fileSize: parseInt(fileSize),
    userId,
    hash: imageHash,
    fileName,
    sessionId
  }
}

module.exports = {
  generatePolicySignature,
  verifyOSSCallbackSignature,
  buildOSSCallbackUrl,
  parseCallbackData
}
