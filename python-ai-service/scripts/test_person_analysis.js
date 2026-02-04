#!/usr/bin/env node
"use strict";

/**
 * 使用 Node.js 模拟业务端调用 AI 图片分析服务。
 * - 默认读取 `../testImages` 目录中的样例图片
 * - 依次向 `/analyze_person` 接口发起 multipart/form-data 请求
 * - 支持通过 CLI 参数或环境变量覆盖请求配置
 *
 * 使用方式：
 *   1. 先启动 python-ai-service（确保服务已加载所有模型）
 *   2. 在当前目录运行：
 *        node scripts/test_person_analysis.js
 *      或者指定图片：
 *        node scripts/test_person_analysis.js path/to/a.jpg path/to/b.jpg
 *
 * 环境变量：
 *   - AI_SERVICE_URL  覆盖完整请求地址，例如 http://127.0.0.1:5001
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");

const DEFAULT_SERVICE_URL = process.env.AI_SERVICE_URL || `http://127.0.0.1:${process.env.AI_SERVICE_PORT || settingsPortFallback()}`;

function settingsPortFallback() {
  // 与 config.Settings.PORT 默认值保持一致
  return "5001";
}

async function resolveImages(argv) {
  if (argv.length > 0) {
    return argv.map((p) => path.resolve(p));
  }

  const fallbackDir = path.resolve(__dirname, "../testImages");
  const entries = await fs.readdir(fallbackDir);
  return entries.filter((name) => /\.(jpe?g|png)$/i.test(name)).map((name) => path.join(fallbackDir, name));
}

async function main() {
  const images = await resolveImages(process.argv.slice(2));
  if (images.length === 0) {
    console.error("未找到可用的测试图片，请至少提供一张 JPG/PNG 图片");
    process.exitCode = 1;
    return;
  }

  const endpoint = `${DEFAULT_SERVICE_URL.replace(/\/$/, "")}/analyze_person`;
  const { FormData } = await import("undici");
  const { Blob } = await import("buffer");

  console.log(`🛰️ 目标接口: ${endpoint}`);

  for (const imagePath of images) {
    try {
      const fileBuffer = await fs.readFile(imagePath);
      const fileName = path.basename(imagePath);

      const form = new FormData();
      const blob = new Blob([fileBuffer], { type: "image/jpeg" });
      form.append("image", blob, fileName);

      console.log(`\n📤 上传图片: ${fileName}`);
      const response = await fetch(endpoint, { method: "POST", body: form });

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        const errorPayload = contentType.includes("application/json") ? await response.json() : await response.text();
        console.error("❌ 请求失败:", errorPayload);
        continue;
      }

      const result = contentType.includes("application/json") ? await response.json() : await response.text();

      console.log("✅ 分析成功:");
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
