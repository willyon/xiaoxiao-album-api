/*
 * @Author: zhangshouchang
 * @Date: 2025-01-06
 * @Description: 清理 BullMQ 队列，支持按队列类型传参
 * @Usage: node scripts/development/clear-queues.js [选项]
 *
 * 选项（可多选，不传则清空全部）：
 *   --upload    仅清空媒体上传队列 (mediaUploadQueue)
 *   --meta      仅清空元数据队列 (mediaMetaQueue)
 *   --analysis  仅清空媒体分析队列 (mediaAnalysisQueue)
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
const CLEAR_ANALYSIS = args.includes("--analysis");
const CLEAR_ALL = args.includes("--all");
const HELP = args.includes("--help") || args.includes("-h");

if (HELP) {
  console.log("用法: node scripts/development/clear-queues.js [选项]");
  console.log("");
  console.log("选项（可多选，不传则清空全部）：");
  console.log("  --upload    仅清空图片上传队列");
  console.log("  --meta      仅清空元数据队列");
  console.log("  --analysis  仅清空媒体分析队列");
  console.log("  --all       清空以上全部");
  console.log("  -h, --help  显示帮助");
  console.log("");
  console.log("示例:");
  console.log("  node scripts/development/clear-queues.js             # 清空全部");
  console.log("  node scripts/development/clear-queues.js --analysis # 仅清空 analysis 队列");
  console.log("  node scripts/development/clear-queues.js --upload --meta");
  process.exit(0);
}

const clearAll = !CLEAR_UPLOAD && !CLEAR_META && !CLEAR_ANALYSIS;
const doUpload = clearAll || CLEAR_UPLOAD || CLEAR_ALL;
const doMeta = clearAll || CLEAR_META || CLEAR_ALL;
const doAnalysis = clearAll || CLEAR_ANALYSIS || CLEAR_ALL;

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
  const { mediaAnalysisQueue } = require(path.join(projectRoot, "src", "queues", "mediaAnalysisQueue"));

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
  if (doAnalysis) {
    console.log("🔬 清空媒体分析队列...");
    const s = await clearQueue(mediaAnalysisQueue, "analysis");
    console.log(`   ✅ 媒体分析队列: 等待${s.waiting} | 活跃${s.active} | 完成${s.completed} | 失败${s.failed} | 延迟${s.delayed}`);
  }
  console.log("🎉 队列清理完成");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 清空队列失败：", err);
    process.exit(1);
  });
