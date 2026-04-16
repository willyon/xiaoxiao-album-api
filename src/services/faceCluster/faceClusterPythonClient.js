/**
 * 人脸聚类 Python 客户端：统一封装健康检查、聚类请求与人脸缩略图裁剪请求。
 */
const axios = require('axios')
const FormData = require('form-data')

/**
 * 检查 Python 服务健康状态。
 * @param {string} serviceUrl Python 服务基地址
 * @returns {Promise<any>} 健康检查响应体
 */
async function checkPythonServiceHealth(serviceUrl) {
  const response = await axios.get(`${serviceUrl}/health`, {
    timeout: 30000
  })
  return response.data
}

/**
 * 调用 Python 聚类接口。
 * @param {string} serviceUrl Python 服务基地址
 * @param {{embeddings:number[][], threshold?:number}} requestBody 聚类请求体
 * @returns {Promise<any>} 聚类响应体
 */
async function clusterFaceEmbeddings(serviceUrl, requestBody) {
  const response = await axios.post(`${serviceUrl}/cluster_face_embeddings`, requestBody, {
    timeout: 300000,
    headers: {
      'Content-Type': 'application/json'
    }
  })
  return response.data
}

/**
 * 调用 Python 人脸缩略图裁剪接口。
 * @param {string} serviceUrl Python 服务基地址
 * @param {Buffer} imageData 原图二进制
 * @param {number[]} bbox 人脸框 [x1, y1, x2, y2]
 * @returns {Promise<any>} 裁剪响应体
 */
async function cropFaceThumbnail(serviceUrl, imageData, bbox) {
  const formData = new FormData()
  formData.append('image', imageData, 'image.jpg')
  formData.append('bbox', JSON.stringify(bbox))
  const response = await axios.post(`${serviceUrl}/crop_face_thumbnail`, formData, {
    headers: formData.getHeaders(),
    timeout: 30000
  })
  return response.data
}

module.exports = {
  checkPythonServiceHealth,
  clusterFaceEmbeddings,
  cropFaceThumbnail
}
