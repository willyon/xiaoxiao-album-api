/**
 * 逆地理编码服务
 * 将 GPS 坐标转换为可读的位置描述
 * - 配置了 AMAP_API_KEY 时使用高德地图 API
 * - 未配置时：先本地 chinaGeoDataHierarchy.json（省市区）；未命中再用 globalGeoData.json（国家/地区名，中文优先）
 */

const https = require("https");
const logger = require("../utils/logger");
const { wgs84ToGcj02 } = require("../utils/coordinateTransform");
const { getLocationFromCoordinatesLocal } = require("./localReverseGeocodeService");
const { getLocationFromCoordinatesGlobal } = require("./globalReverseGeocodeService");

/**
 * 使用高德地图API进行逆地理编码
 * 照片exif信息中获取的经纬度是WGS-84坐标系
 * @param {number} latitude - 纬度 (WGS-84坐标系)
 * @param {number} longitude - 经度 (WGS-84坐标系)
 * @returns {Promise<{
 *   formattedAddress: string|null,
 *   country: string|null,
 *   province: string|null,
 *   city: string|null,
 *   district: string|null
 * }|null>} 结构化位置对象或 null
 */
async function getLocationFromCoordinates(latitude, longitude) {
  if (!latitude || !longitude) {
    return null;
  }

  // EXIF 为 WGS-84。高德与 DataV 中国边界为 GCJ-02，故中国区划/高德统一用 GCJ。
  // `wgs84ToGcj02` 仅在 `isInChina` 粗略矩形内做偏移；矩形外保持 WGS。
  // 全球 Natural Earth 为 CRS84/WGS-84，兜底时必须用**原始 WGS**，不能用 GCJ：
  // 若真实位置在境外但落在 `isInChina` 矩形内，会被误转 GCJ；中国区划未命中时若仍用 GCJ 去匹配全球多边形，会错国/漏判。
  const gcj02Coords = wgs84ToGcj02(longitude, latitude);

  const apiKey = (process.env.AMAP_API_KEY || "").trim();
  // 未配置高德：先中国本地（GCJ），未命中再全球（WGS）。多数用户照片在中国时，先试中国成本可接受，无需先判「是否在中国」。
  if (!apiKey) {
    const local = getLocationFromCoordinatesLocal(gcj02Coords.lat, gcj02Coords.lng);
    if (local) {
      logger.info({
        message: "本地行政区划逆地理编码成功",
        details: {
          latitude,
          longitude,
          formattedAddress: local.formattedAddress,
          province: local.province,
          city: local.city,
          district: local.district,
        },
      });
      return local;
    }
    const globalLoc = getLocationFromCoordinatesGlobal(latitude, longitude);
    if (globalLoc) {
      logger.info({
        message: "本地全球国家/地区逆地理编码成功",
        details: {
          latitude,
          longitude,
          formattedAddress: globalLoc.formattedAddress,
          country: globalLoc.country,
        },
      });
    }
    return globalLoc;
  }

  try {
    logger.info({
      message: "坐标转换完成",
      details: {
        original: { longitude, latitude, system: "WGS-84" },
        converted: { longitude: gcj02Coords.lng, latitude: gcj02Coords.lat, system: "GCJ-02" },
      },
    });

    // 高德地图逆地理编码 API（GCJ-02）
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
      const formattedAddress = data.regeocode.formatted_address || null;
      const comp = data.regeocode.addressComponent || {};

      // 提取位置信息
      const country = comp.country || null;
      const province = comp.province || null;

      // city 字段处理：
      // 1. 直辖市场景：city 可能为空字符串，需要用 province 兜底
      // 2. 边界区域：city 可能为数组（如省直辖县级市、多个城市间的边界位置）
      // 3. 正常场景：city 为字符串
      const city = (comp.city && (typeof comp.city === "string" ? comp.city : comp.city[0])) || province || null;

      const district = comp.district || null;

      if (!formattedAddress || typeof formattedAddress !== "string" || formattedAddress.trim() === "") {
        logger.warn({
          message: "高德逆地理编码返回空地址",
          details: {
            latitude,
            longitude,
            formatted_address: formattedAddress,
            apiStatus: data.status,
            infoCode: data.infocode,
          },
        });
      }

      logger.info({
        message: "高德逆地理编码成功",
        details: {
          latitude,
          longitude,
          formattedAddress,
          country,
          province,
          city,
          district,
          apiStatus: data.status,
          infoCode: data.infocode,
        },
      });

      return { formattedAddress, country, province, city, district };
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
