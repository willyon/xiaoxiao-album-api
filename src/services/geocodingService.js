/**
 * 逆地理编码服务
 * 将 GPS 坐标转换为可读的位置描述
 * 使用高德地图API
 */

const https = require("https");
const logger = require("../utils/logger");
const { wgs84ToGcj02 } = require("../utils/coordinateTransform");

/**
 * 使用高德地图API进行逆地理编码
 * 照片exif信息中获取的经纬度是WGS-84坐标系
 * @param {number} latitude - 纬度 (WGS-84坐标系)
 * @param {number} longitude - 经度 (WGS-84坐标系)
 * @returns {Promise<string|null>} 位置描述或 null
 */
async function getLocationFromCoordinates(latitude, longitude) {
  if (!latitude || !longitude) {
    return null;
  }

  const apiKey = process.env.AMAP_API_KEY;
  if (!apiKey) {
    logger.warn({
      message: "高德地图API Key未配置，跳过逆地理编码",
      details: { latitude, longitude },
    });
    return null;
  }

  try {
    // 1. 坐标转换：WGS-84 -> GCJ-02 (高德地图使用GCJ-02坐标系)
    const gcj02Coords = wgs84ToGcj02(longitude, latitude);

    logger.info({
      message: "坐标转换完成",
      details: {
        original: { longitude, latitude, system: "WGS-84" },
        converted: { longitude: gcj02Coords.lng, latitude: gcj02Coords.lat, system: "GCJ-02" },
      },
    });

    // 2. 高德地图逆地理编码API - 使用转换后的GCJ-02坐标
    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${apiKey}&location=${gcj02Coords.lng},${gcj02Coords.lat}&extensions=all&poitype=&radius=500&roadlevel=0&output=json`;

    const data = await new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            // 设置User-Agent头，便于后续排查和统计，只是为了方便日志查询，起什么名字都可以
            "User-Agent": "photos.bingbingcloud.com/1.0",
          },
          timeout: 3000, // 3秒超时
        },
        (response) => {
          let data = "";

          response.on("data", (chunk) => {
            data += chunk;
          });

          response.on("end", () => {
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (error) {
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          });
        },
      );

      request.on("error", (error) => {
        reject(new Error(`网络请求失败: ${error.message}`));
      });

      request.setTimeout(3000, () => {
        request.destroy();
        reject(new Error("请求超时"));
      });
    });

    // 检查API响应
    if (data && data.status === "1" && data.regeocode) {
      // 直接使用高德地图返回的格式化地址
      const location = data.regeocode.formatted_address;

      // 检查 formatted_address 是否为空
      if (!location || typeof location !== "string" || location.trim() === "") {
        logger.warn({
          message: "高德逆地理编码返回空地址",
          details: {
            latitude,
            longitude,
            formatted_address: location,
            apiStatus: data.status,
            infoCode: data.infocode,
          },
        });
        return null;
      }

      logger.info({
        message: "高德逆地理编码成功",
        details: {
          latitude,
          longitude,
          location,
          apiStatus: data.status,
          infoCode: data.infocode,
        },
      });

      return location;
    } else {
      logger.warn({
        message: "高德逆地理编码API返回错误",
        details: {
          latitude,
          longitude,
          status: data?.status,
          info: data?.info,
          infocode: data?.infocode,
        },
      });
      return null;
    }
  } catch (error) {
    logger.warn({
      message: "高德逆地理编码失败，跳过位置描述",
      details: { latitude, longitude, error: error.message },
    });
    return null;
  }
}

module.exports = {
  getLocationFromCoordinates,
};
