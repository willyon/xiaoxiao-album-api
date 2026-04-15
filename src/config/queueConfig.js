/*
 * @Description: Queue runtime config
 */

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

const QUEUE_JOB_ATTEMPTS = toPositiveInt(process.env.QUEUE_JOB_ATTEMPTS, 3);

module.exports = {
  QUEUE_JOB_ATTEMPTS,
};

