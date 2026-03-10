let inFlight = 0;
const queue = [];

function resolveMax() {
  const raw = Number(process.env.AI_MAX_CONCURRENCY);
  if (!Number.isNaN(raw) && raw > 0) return raw;
  return 1;
}

async function acquire() {
  const max = resolveMax();
  if (inFlight < max) {
    inFlight += 1;
    return;
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  inFlight -= 1;
  if (inFlight < 0) inFlight = 0;
  if (queue.length > 0) {
    inFlight += 1;
    const next = queue.shift();
    next();
  }
}

async function withAiSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = {
  withAiSlot,
};

