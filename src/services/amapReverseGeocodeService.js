/**
 * 高德地图逆地理编码（GCJ-02）
 * 仅负责 HTTPS 请求与响应解析；失败时返回结构化结果供上层降级，网络/超时/JSON 解析错误则抛错。
 */

const https = require('https')
const logger = require('../utils/logger')

/**
 * 判断高德返回是否包含可用位置字段。
 * @param {{formattedAddress?:string|null,country?:string|null,province?:string|null,city?:string|null,district?:string|null}} result - 逆地理结果。
 * @returns {boolean} 是否可用。
 */
function amapResultHasUsableLocation({ formattedAddress, country, province, city, district }) {
  const addr = formattedAddress && typeof formattedAddress === 'string' && formattedAddress.trim() !== ''
  return Boolean(addr || country || province || city || district)
}

/**
 * @param {string} apiKey
 * @param {{ lat: number, lng: number }} gcj02Coords 高德入参为 GCJ-02
 * @param {number} wgsLatitude 仅用于日志（WGS-84）
 * @param {number} wgsLongitude
 * @returns {Promise<{ success: true, result: object } | { success: false, fallbackReason: string }>}
 * @throws {Error} 网络失败、超时、响应非 JSON
 */
async function getLocationFromCoordinatesAmap(apiKey, gcj02Coords, wgsLatitude, wgsLongitude) {
  const latitude = wgsLatitude
  const longitude = wgsLongitude

  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${apiKey}&location=${gcj02Coords.lng},${gcj02Coords.lat}&extensions=all&poitype=&radius=500&roadlevel=0&output=json`

  const data = await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'photos.bingbingcloud.com/1.0'
        },
        timeout: 3000
      },
      (response) => {
        let buf = ''

        response.on('data', (chunk) => {
          buf += chunk
        })

        response.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (error) {
            reject(new Error(`JSON解析失败: ${error.message}`))
          }
        })
      }
    )

    request.on('error', (error) => {
      reject(new Error(`网络请求失败: ${error.message}`))
    })

    request.setTimeout(3000, () => {
      request.destroy()
      reject(new Error('请求超时'))
    })
  })

  if (!data || data.status !== '1' || !data.regeocode) {
    logger.warn({
      message: '高德逆地理编码API返回错误',
      details: {
        latitude,
        longitude,
        status: data?.status,
        info: data?.info,
        infocode: data?.infocode
      }
    })
    return { success: false, fallbackReason: '高德逆地理API返回错误' }
  }

  const formattedAddress = data.regeocode.formatted_address || null
  const comp = data.regeocode.addressComponent || {}

  const country = comp.country || null
  const province = comp.province || null
  const city = (comp.city && (typeof comp.city === 'string' ? comp.city : comp.city[0])) || province || null
  const district = comp.district || null

  const result = { formattedAddress, country, province, city, district }

  if (!amapResultHasUsableLocation(result)) {
    logger.warn({
      message: '高德逆地理编码无有效地址与行政区划，降级本地',
      details: { latitude, longitude, apiStatus: data.status, infoCode: data.infocode }
    })
    return { success: false, fallbackReason: '高德返回空有效位置字段' }
  }

  if (!formattedAddress || typeof formattedAddress !== 'string' || formattedAddress.trim() === '') {
    logger.warn({
      message: '高德逆地理编码返回空地址字符串',
      details: {
        latitude,
        longitude,
        formatted_address: formattedAddress,
        apiStatus: data.status,
        infoCode: data.infocode
      }
    })
  }

  logger.info({
    message: '高德逆地理编码成功',
    details: {
      latitude,
      longitude,
      formattedAddress,
      country,
      province,
      city,
      district,
      apiStatus: data.status,
      infoCode: data.infocode
    }
  })

  return { success: true, result }
}

module.exports = {
  getLocationFromCoordinatesAmap
}
