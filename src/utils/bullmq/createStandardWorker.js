const { Worker } = require('bullmq')
const IORedis = require('ioredis')
const logger = require('../logger')
const { attachStandardFailedLogging } = require('./bullmqWorkerTelemetry')
const initGracefulShutdown = require('../gracefulShutdown')

/**
 * 创建标准化 BullMQ Worker，统一失败日志、stalled 监听和优雅关闭。
 * @param {{
 * queueName:string,
 * processor:(job: import('bullmq').Job) => Promise<any>,
 * concurrency?:number,
 * logPrefix:string,
 * startupMessage?:string,
 * onCompleted?:(job: import('bullmq').Job) => void,
 * failedLoggingOptions?:Record<string, any>
 * }} options - Worker 配置。
 * @returns {import('bullmq').Worker} Worker 实例。
 */
function createStandardWorker(options) {
  const {
    queueName,
    processor,
    concurrency,
    logPrefix,
    startupMessage,
    onCompleted,
    failedLoggingOptions = {}
  } = options

  const connection = new IORedis({ maxRetriesPerRequest: null })
  const worker = new Worker(queueName, processor, {
    connection,
    ...(concurrency ? { concurrency } : {})
  })

  logger.info({
    message: startupMessage || `${logPrefix} 已启动，队列名=${queueName}${concurrency ? `，并发数=${concurrency}` : ''}`
  })

  attachStandardFailedLogging(worker, queueName, { logPrefix, ...failedLoggingOptions })

  if (typeof onCompleted === 'function') {
    worker.on('completed', onCompleted)
  }
  worker.on('stalled', (jobId) => {
    logger.warn({ message: `${logPrefix}.stalled`, details: { jobId } })
  })

  initGracefulShutdown({
    extraClosers: [async () => worker.close(), async () => connection.quit()]
  })

  return worker
}

module.exports = {
  createStandardWorker
}
