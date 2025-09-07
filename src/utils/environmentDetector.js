/**
 * 阿里云ECS环境检测工具
 *
 * 功能说明：
 * 检测是否在阿里云ECS环境中运行
 *
 * 应用场景：
 * - 智能选择OSS内网/外网地址
 * - 根据环境调整配置参数
 *
 * 检测方法：
 * 通过ECS实例元数据服务检测（最可靠）
 *
 * @author zhangshouchang
 * @date 2025-09-02
 */

const http = require("http");
const logger = require("./logger");

/**
 * 检测是否在阿里云ECS环境中运行
 *
 * 检测原理：
 * 1. 尝试访问阿里云ECS实例元数据服务
 * 2. 该服务只在ECS实例内部可访问，外网无法访问
 * 3. 如果能成功访问，说明当前环境是阿里云ECS
 *
 * @returns {Promise<boolean>} 是否在阿里云ECS中
 */
async function isAliyunECS() {
  try {
    // 方法1: 检查ECS实例元数据服务
    // 这个地址是阿里云的元数据服务地址
    // 它是一个本地特殊的HTTP接口，只能在云服务器的虚拟机内部访问，对外网不可见
    // 当我们在ECS里访问这个地址时，云平台会返回当前实例的一些元信息
    const metadataUrl = "http://100.100.100.200/latest/meta-data/instance-id";

    const result = await new Promise((resolve, reject) => {
      // 创建HTTP请求访问阿里云ECS元数据服务
      const request = http.get(
        metadataUrl,
        {
          timeout: 2000, // 基础超时设置：2秒后自动超时
        },
        (response) => {
          if (response.statusCode === 200) {
            // 能成功访问元数据服务，说明在ECS中
            resolve(true);
          } else {
            resolve(false);
          }
        },
      );

      // 处理网络错误（如连接失败、DNS解析失败等）
      request.on("error", () => {
        resolve(false);
      });

      // 额外的超时保障机制
      // 为什么需要setTimeout？
      // 1. timeout选项在某些网络环境下可能不够可靠
      // 2. setTimeout提供了更可控的超时处理
      // 3. 显式调用destroy()确保资源被正确清理，防止内存泄漏
      request.setTimeout(2000, () => {
        request.destroy(); // 显式销毁连接，释放系统资源
        resolve(false);
      });
    });

    if (result) {
      logger.info({
        message: "检测到阿里云ECS环境",
        details: { environment: "aliyun-ecs" },
      });
      return true;
    }

    // 检测完成：未检测到阿里云ECS环境
    logger.info({
      message: "未检测到阿里云ECS环境",
      details: { environment: "non-aliyun" },
    });
    return false;
  } catch (error) {
    logger.warn({
      message: "环境检测失败，默认使用外网地址",
      details: { error: error.message },
    });
    return false;
  }
}

module.exports = {
  isAliyunECS,
};
