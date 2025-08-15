/*
 * @Author: zhangshouchang
 * @Date: 2025-08-15 15:27:17
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-15 16:07:46
 * @Description:
 *   提供一个“流式”计算文件哈希的工具函数。
 *
 *   设计要点与动机：
 *   1) 低内存：使用 fs.createReadStream 逐块读取文件，不把整文件一次性读入内存；
 *   2) 稳定可靠：使用 Node.js 内置 crypto 模块的 Hash 可写流来累计摘要；
 *   3) 正确时机：只有在 Hash 流触发 'finish' 事件后，最终摘要才完整，可安全地调用 digest()；
 *   4) 统一输出：以十六进制字符串（hex）返回摘要，便于落库、比对、去重；
 *   5) 可配置算法：默认 'sha256'，也可按需切换 'md5'/'sha1'（注意安全性差异）。
 */
const fs = require("fs");
const crypto = require("crypto");

/**
 * 流式计算文件哈希（低内存、可靠）
 * @param {string} filePath - 需要计算哈希的文件路径（绝对/相对）
 * @param {('sha256'|'md5'|'sha1')} [algo='sha256'] - 哈希算法；默认更安全的 sha256
 * @returns {Promise<string>} 以十六进制（hex）字符串形式返回的哈希值
 *
 * 工作流程（极简版）：
 *   new Promise -> createHash(algo) -> createReadStream(filePath) -> rs.pipe(hash)
 *                 -> 监听 hash 的 'finish' 事件 -> hash.digest('hex') -> resolve
 *
 * 关键细节：
 *   - Hash 实例在这里可看作“可写流”（Writable）：我们把字节写进去，它内部维护一个累积的摘要状态；
 *   - 只有当所有字节都写入完毕（'finish'）后，最终摘要才完整；
 *   - hash.digest() 只能调用一次；再次调用会抛出错误；
 *   - 任何底层错误（读流/哈希流）都会向上抛到 Promise.reject，便于调用方统一处理。
 */
function computeFileHash(filePath, algo = "sha256") {
  return new Promise((resolve, reject) => {
    // 1) 构造哈希计算器（同步创建，若 algo 不合法将抛出）
    const hash = crypto.createHash(algo);

    // 2) 创建一个文件可读流，逐块读取，避免大文件一次性占用内存
    const rs = fs.createReadStream(filePath);

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
  });
}

module.exports = { computeFileHash };
