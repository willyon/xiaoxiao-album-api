/*
 * BullMQ 队列工厂：集中 IORedis + Queue + defaultJobOptions，避免各 queues/*.js 重复样板。
 */
const { Queue } = require('bullmq')
const IORedis = require('ioredis')
const { QUEUE_JOB_ATTEMPTS, QUEUE_JOB_BACKOFF_DELAY } = require('../../config/queueConfig')

/**
 * 失败任务：业务侧不消费 failed 集合，故统一 removeOnFail: true，避免 Redis 堆积失败记录。
 * （若省略 removeOnFail，BullMQ 默认往往会长期保留失败 job。）
 *
 * @param {{ name: string }} options
 * @returns {{ queue: import('bullmq').Queue, connection: import('ioredis').default }}
 */
function createBullQueue({ name }) {
  const connection = new IORedis({ maxRetriesPerRequest: null })
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: QUEUE_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: QUEUE_JOB_BACKOFF_DELAY
      },
      removeOnComplete: true,
      removeOnFail: true
    }
  })
  return { queue, connection }
}

module.exports = { createBullQueue }
