#!/usr/bin/env node

/**
 * API 打包产物清理脚本（仅作用于打包副本目录，不修改源码）。
 * - 移除 JS 注释
 * - 压缩空白/空行
 * - 移除 console.* 调用
 * - 保留业务 logger.* 调用
 */
const fs = require('node:fs')
const path = require('node:path')
const { minify } = require('terser')

const targetArg = process.argv[2] || 'backend-dist'
const targetDir = path.resolve(process.cwd(), targetArg)
const jsExt = new Set(['.js', '.cjs', '.mjs'])
const skipDirs = new Set(['node_modules', '.git', 'logs'])
let touched = 0

/**
 * 递归收集目标目录下的 JS 文件路径。
 *
 * @param {string} dir - 当前遍历目录。
 * @param {string[]} [files=[]] - 结果数组（递归复用）。
 * @returns {string[]} JS 文件绝对路径列表。
 */
function walk(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      walk(full, files)
      continue
    }
    if (jsExt.has(path.extname(entry.name))) files.push(full)
  }
  return files
}

/**
 * 清理单个 JS 文件并覆盖写回。
 *
 * @param {string} filePath - 目标 JS 文件路径。
 * @returns {Promise<void>} 清理完成。
 */
async function sanitizeFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const result = await minify(source, {
    compress: {
      drop_console: true
    },
    mangle: false,
    format: {
      comments: false,
      beautify: false
    }
  })

  if (!result.code || typeof result.code !== 'string') {
    throw new Error(`terser output empty for ${filePath}`)
  }
  fs.writeFileSync(filePath, `${result.code}\n`, 'utf8')
  touched += 1
}

/**
 * 脚本主入口：校验目录、遍历并清理、输出统计。
 *
 * @returns {Promise<void>} 执行完成。
 */
async function main() {
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`Invalid target dir: ${targetDir}`)
  }
  const files = walk(targetDir)
  await Promise.all(files.map((file) => sanitizeFile(file)))
  console.log(`✅ 已清理 JS 打包产物: ${touched} 个文件 (${targetDir})`)
}

main().catch((err) => {
  console.error('❌ sanitize-js-for-bundle 失败:', err.message)
  process.exit(1)
})
