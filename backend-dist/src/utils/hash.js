/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 15:27:17
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-29 16:07:46
 * @Description:
 *   提供统一的哈希计算工具函数，支持文件路径和Buffer两种输入模式。
 *
 *   设计要点与动机：
 *   1) 双模式支持：既支持文件路径（流式处理），也支持Buffer（直接处理）；
 *   2) 低内存：文件模式使用 fs.createReadStream 逐块读取，不把整文件一次性读入内存；
 *   3) 稳定可靠：使用 Node.js 内置 crypto 模块的 Hash 来计算摘要；
 *   4) 统一输出：以十六进制字符串（hex）返回摘要，便于落库、比对、去重；
 *   5) 可配置算法：默认 'sha256'，也可按需切换 'md5'/'sha1'（注意安全性差异）；
 *   6) 存储适配：支持本地文件存储（文件路径）和OSS存储（Buffer）两种场景。
 */
const fs = require("fs");
const crypto = require("crypto");

/**
 * 计算文件或Buffer的哈希值
 * @param {string|Buffer} input - 文件路径（string）或Buffer数据
 * @param {('sha256'|'md5'|'sha1')} [algo='sha256'] - 哈希算法；默认更安全的 sha256
 * @returns {Promise<string>} 以十六进制（hex）字符串形式返回的哈希值
 *
 */
function computeFileHash(input, algo = "sha256") {
  return new Promise((resolve, reject) => {
    try {
      // 1) 构造哈希计算器（同步创建，若 algo 不合法将抛出）
      const hash = crypto.createHash(algo);

      if (Buffer.isBuffer(input)) {
        // Buffer模式：直接计算哈希
        hash.update(input);
        const hex = hash.digest("hex");
        resolve(hex);
      } else if (typeof input === "string") {
        // 文件路径模式：流式计算（低内存、可靠）
        // 2) 创建一个文件可读流，逐块读取，避免大文件一次性占用内存
        const rs = fs.createReadStream(input);

        // 3) 将底层错误透传到 Promise（例如文件不存在、读权限不足等）
        rs.on("error", reject);
        hash.on("error", reject);

        // 4) 写入结束 -> 导出最终摘要
        //    注意：digest() 只能调用一次；如果在 'finish' 之外的时机调用，摘要可能不完整
        hash.once("finish", () => {
          try {
            const hex = hash.digest("hex"); // 把二进制摘要编码为十六进制字符串
            resolve(hex);
          } catch (e) {
            // 如果重复调用 digest，或 hash 状态异常，会在这里被捕捉
            reject(e);
          }
        });

        // 5) 启动数据管道：文件字节 -> 哈希计算器
        //    管道完成后会自动触发 hash 的 'finish'，从而进入上面的回调
        rs.pipe(hash);
      } else {
        reject(new Error("Input must be a file path (string) or Buffer"));
      }
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { computeFileHash };
