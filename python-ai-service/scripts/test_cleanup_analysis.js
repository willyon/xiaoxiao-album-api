#!/usr/bin/env node
"use strict";

/**
 * 使用 Node.js 测试 /analyze_cleanup 接口。
 * 默认读取 ../testImages 目录下的样例图片，逐张上传并打印返回结果。
 *
 * 运行方式：
 *   node scripts/test_cleanup_analysis.js           # 使用默认图片
 *   node scripts/test_cleanup_analysis.js path/to/image.jpg
 *
 * 可通过环境变量覆盖服务地址：
 *   AI_SERVICE_URL=http://127.0.0.1:5001 node scripts/test_cleanup_analysis.js
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");

const DEFAULT_PORT = process.env.AI_SERVICE_PORT || "5001";
const DEFAULT_URL = (process.env.AI_SERVICE_URL || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");

async function resolveImages(argv) {
  if (argv.length > 0) {
    return argv.map((inputPath) => path.resolve(inputPath));
  }

  const testDir = path.resolve(__dirname, "../testImages");
  const entries = await fs.readdir(testDir);
  return entries
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => path.join(testDir, name));
}

async function main() {
  const images = await resolveImages(process.argv.slice(2));
  if (images.length === 0) {
    console.error("未找到可用测试图片，请指定至少一张 JPG/PNG 图片");
    process.exitCode = 1;
    return;
  }

  const endpoint = `${DEFAULT_URL}/analyze_cleanup`;
  const { FormData } = await import("undici");
  const { Blob } = await import("buffer");

  console.log(`🛰️ 目标接口: ${endpoint}`);

  for (const imagePath of images) {
    try {
      const buffer = await fs.readFile(imagePath);
      const fileName = path.basename(imagePath);

      const form = new FormData();
      form.append("image", new Blob([buffer], { type: "image/jpeg" }), fileName);

      console.log(`\n📤 上传图片: ${fileName}`);
      const response = await fetch(endpoint, { method: "POST", body: form });

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        const payload = contentType.includes("application/json") ? await response.json() : await response.text();
        console.error("❌ 请求失败:", payload);
        continue;
      }

      const result = contentType.includes("application/json") ? await response.json() : await response.text();
      console.log("✅ 清理指标：");
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`⚠️ 处理图片 ${imagePath} 时出错:`, error);
    }
  }
}

main().catch((error) => {
  console.error("脚本执行失败:", error);
  process.exitCode = 1;
});

