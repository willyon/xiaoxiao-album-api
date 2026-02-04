#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

/**
 * 对 backend-dist 中的 .env 脱敏：按认证类型移除敏感信息（如 AccessKey），供打包部署用。
 * 由 npm run build 在复制完 backend-dist 后调用。
 */

const SENSITIVE_KEYS = ["ALIYUN_OSS_ACCESS_KEY_ID", "ALIYUN_OSS_ACCESS_KEY_SECRET"];

function removeSensitiveKeysFromEnv(sourceEnvPath, targetEnvPath) {
  try {
    // 读取原始 .env 文件
    const envContent = fs.readFileSync(sourceEnvPath, "utf8");

    // 解析 .env 文件获取认证类型
    const authType = getAuthTypeFromEnv(envContent);
    console.log(`🔍 检测到认证类型: ${authType}`);

    // 如果是 accesskey 模式，不删除任何内容
    if (authType === "accesskey") {
      console.log("🔑 使用 AccessKey 认证模式，保留所有配置");
      fs.writeFileSync(targetEnvPath, envContent);
      console.log(`✅ 已创建生产环境 .env 文件: ${targetEnvPath}`);
      return;
    }

    // 非 accesskey 模式，移除敏感信息
    console.log("🛡️ 非 AccessKey 认证模式，移除敏感信息");
    const lines = envContent.split("\n");
    const filteredLines = lines.map((line) => {
      // 跳过空行和注释
      if (!line.trim() || line.trim().startsWith("#")) {
        return line;
      }

      // 检查是否包含敏感键
      const key = line.split("=")[0];
      if (SENSITIVE_KEYS.includes(key)) {
        console.log(`🔒 移除敏感信息: ${key}`);
        return `# ${line} # 已移除敏感信息`;
      }

      return line;
    });

    // 写入过滤后的 .env 文件
    fs.writeFileSync(targetEnvPath, filteredLines.join("\n"));
    console.log(`✅ 已创建生产环境 .env 文件: ${targetEnvPath}`);
  } catch (error) {
    console.error("❌ 处理 .env 文件时出错:", error.message);
    process.exit(1);
  }
}

/**
 * 从 .env 文件内容中提取认证类型
 * @param {string} envContent - .env 文件内容
 * @returns {string} 认证类型
 */
function getAuthTypeFromEnv(envContent) {
  const lines = envContent.split("\n");
  for (const line of lines) {
    if (line.trim() && !line.trim().startsWith("#")) {
      const [key, value] = line.split("=");
      if (key === "ALIYUN_OSS_AUTH_TYPE") {
        return value?.trim() || "ecs_ram_role"; // 默认值
      }
    }
  }
  return "ecs_ram_role"; // 默认值
}

function main() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const sourceEnvPath = path.join(projectRoot, ".env");
  const targetEnvPath = path.join(projectRoot, "backend-dist", ".env");

  // 检查源 .env 文件是否存在
  if (!fs.existsSync(sourceEnvPath)) {
    console.log("⚠️  源 .env 文件不存在，跳过处理");
    return;
  }

  // 确保目标目录存在
  const targetDir = path.dirname(targetEnvPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 处理 .env 文件
  removeSensitiveKeysFromEnv(sourceEnvPath, targetEnvPath);

  console.log("🎉 生产环境构建完成！");
  console.log("📝 已移除的敏感信息:", SENSITIVE_KEYS.join(", "));
}

if (require.main === module) {
  main();
}

module.exports = { removeSensitiveKeysFromEnv, SENSITIVE_KEYS };
