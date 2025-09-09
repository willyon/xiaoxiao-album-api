/*
 * @Author: zhangshouchang
 * @Date: 2025-01-08
 * @Description: OSS签名工具函数
 */
const crypto = require("crypto");

/**
 * 生成OSS回调签名
 * @param {string} callbackBody - 回调体
 * @param {string} callbackUrl - 回调URL
 * @param {string} accessKeySecret - 访问密钥
 * @returns {string} 签名字符串
 */
function generateCallbackSignature(callbackBody, callbackUrl, accessKeySecret) {
  if (!accessKeySecret) {
    throw new Error("AccessKeySecret is required for callback signature generation");
  }

  const stringToSign = callbackBody + callbackUrl;
  return crypto.createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
}

/**
 * 验证OSS回调签名
 * @param {string} callbackBody - 回调体
 * @param {string} callbackUrl - 回调URL
 * @param {string} receivedSignature - 接收到的签名
 * @param {string} accessKeySecret - 访问密钥
 * @returns {boolean} 验证结果
 */
function verifyCallbackSignature(callbackBody, callbackUrl, receivedSignature, accessKeySecret) {
  if (!accessKeySecret) {
    return false; // 没有密钥时验证失败
  }

  const expectedSignature = generateCallbackSignature(callbackBody, callbackUrl, accessKeySecret);
  return expectedSignature === receivedSignature;
}

/**
 * 生成OSS上传策略签名
 * @param {string} policyString - 策略字符串（已Base64编码）
 * @param {string} accessKeySecret - 访问密钥
 * @returns {string} 策略签名
 */
function generatePolicySignature(policyString, accessKeySecret) {
  if (!accessKeySecret) {
    throw new Error("AccessKeySecret is required for policy signature generation");
  }

  // 阿里云OSS的策略签名验证强制要求使用SHA-1
  return crypto.createHmac("sha1", accessKeySecret).update(policyString).digest("base64");
}

module.exports = {
  generateCallbackSignature,
  verifyCallbackSignature,
  generatePolicySignature,
};
