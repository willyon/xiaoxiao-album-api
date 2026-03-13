/*
 * @Author: zhangshouchang
 * @Date: 2025-01-06
 * @Description: 清理 BullMQ 队列，支持按队列类型传参
 * @Usage: node scripts/development/clear-queues.js [选项]
 *
 * 选项（可多选，不传则清空全部）：
 *   --upload    仅清空媒体上传队列 (mediaUploadQueue)
 *   --meta      仅清空元数据队列 (mediaMetaQueue)
 *   --search    仅清空搜索索引/人脸识别队列 (searchIndexQueue)
 *   --cleanup   仅清空清理分析队列 (cleanupQueue)
 *   --all       清空以上全部（默认）
 *   -h, --help  显示帮助
 */

const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const args = process.argv.slice(2);
const CLEAR_UPLOAD = args.includes("--upload");
const CLEAR_META = args.includes("--meta");
const CLEAR_SEARCH = args.includes("--search");
const CLEAR_CLEANUP = args.includes("--cleanup");
const CLEAR_ALL = args.includes("--all");
const HELP = args.includes("--help") || args.includes("-h");

if (HELP) {
  console.log("用法: node scripts/development/clear-queues.js [选项]");
  console.log("");
  console.log("选项（可多选，不传则清空全部）：");
  console.log("  --upload    仅清空图片上传队列");
  console.log("  --meta      仅清空元数据队列");
  console.log("  --search    仅清空搜索索引/人脸识别队列");
  console.log("  --cleanup   仅清空清理分析队列");
  console.log("  --all       清空以上全部");
  console.log("  -h, --help  显示帮助");
  console.log("");
  console.log("示例:");
  console.log("  node scripts/development/clear-queues.js           # 清空全部");
  console.log("  node scripts/development/clear-queues.js --search  # 仅清空 search 队列");
  console.log("  node scripts/development/clear-queues.js --upload --meta");
  process.exit(0);
}

const clearAll = !CLEAR_UPLOAD && !CLEAR_META && !CLEAR_SEARCH && !CLEAR_CLEANUP;
const doUpload = clearAll || CLEAR_UPLOAD || CLEAR_ALL;
const doMeta = clearAll || CLEAR_META || CLEAR_ALL;
const doSearch = clearAll || CLEAR_SEARCH || CLEAR_ALL;
const doCleanup = clearAll || CLEAR_CLEANUP || CLEAR_ALL;

async function clearQueue(queue, name) {
  const stats = {
    waiting: await queue.clean(0, 1000, "waiting"),
    active: await queue.clean(0, 1000, "active"),
    completed: await queue.clean(0, 1000, "completed"),
    failed: await queue.clean(0, 1000, "failed"),
    delayed: await queue.clean(0, 1000, "delayed"),
  };
  await queue.drain(true);
  return stats;
}

async function main() {
  const { mediaUploadQueue } = require(path.join(projectRoot, "src", "queues", "mediaUploadQueue"));
  const { mediaMetaQueue } = require(path.join(projectRoot, "src", "queues", "mediaMetaQueue"));
  const { searchIndexQueue } = require(path.join(projectRoot, "src", "queues", "searchIndexQueue"));
  const { cleanupQueue } = require(path.join(projectRoot, "src", "queues", "cleanupQueue"));

  console.log("🚀 开始清空 BullMQ 队列...");
  if (doUpload) {
    console.log("📤 清空图片上传队列...");
    const s = await clearQueue(mediaUploadQueue, "upload");
    console.log(`   ✅ 上传队列: 等待${s.waiting} | 活跃${s.active} | 完成${s.completed} | 失败${s.failed} | 延迟${s.delayed}`);
  }
  if (doMeta) {
    console.log("📊 清空元数据队列...");
    const s = await clearQueue(mediaMetaQueue, "meta");
    console.log(`   ✅ 元数据队列: 等待${s.waiting} | 活跃${s.active} | 完成${s.completed} | 失败${s.failed} | 延迟${s.delayed}`);
  }
  if (doSearch) {
    console.log("👤 清空搜索索引/人脸识别队列...");
    const s = await clearQueue(searchIndexQueue, "search");
    console.log(`   ✅ 搜索索引队列: 等待${s.waiting} | 活跃${s.active} | 完成${s.completed} | 失败${s.failed} | 延迟${s.delayed}`);
  }
  if (doCleanup) {
    console.log("🧹 清空清理分析队列...");
    const s = await clearQueue(cleanupQueue, "cleanup");
    console.log(`   ✅ 清理队列: 等待${s.waiting} | 活跃${s.active} | 完成${s.completed} | 失败${s.failed} | 延迟${s.delayed}`);
  }
  console.log("🎉 队列清理完成");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 清空队列失败：", err);
    process.exit(1);
  });
