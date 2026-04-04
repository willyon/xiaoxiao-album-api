/**
 * BullMQ 与 Job#shouldRetryJob 对齐：判断「本 attempt 失败后队列是否还会自动重试」。
 * 各阶段失败落库与云 caption 一致——重试过程中不写库，仅在终局失败时写 failed。
 */

const { UnrecoverableError } = require("bullmq");

/** 本 attempt 失败后 BullMQ 是否还会自动重试（与 Job#shouldRetryJob 一致） */
function bullMqWillRetryAfterThisFailure(job, err) {
  if (!job) return false;
  if (err && (err instanceof UnrecoverableError || err.name === "UnrecoverableError")) return false;
  if (job.discarded) return false;
  const attempts = Math.max(1, Number(job.opts?.attempts ?? 1));
  const made = Number(job.attemptsMade ?? 0);
  return made + 1 < attempts;
}

module.exports = {
  bullMqWillRetryAfterThisFailure,
};
