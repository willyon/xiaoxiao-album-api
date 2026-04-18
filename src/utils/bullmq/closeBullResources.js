/**
 * 统一关闭 BullMQ Queue 与 Redis 连接，保持容错与日志口径一致。
 * @param {{queue?:{close?:Function},connection?:{quit?:Function},logger:any,label:string}} params
 * @returns {Promise<void>}
 */
async function closeBullResources({ queue, connection, logger, label }) {
  try {
    await queue?.close?.()
  } catch (error) {
    logger.warn({
      message: `关闭 ${label} 队列失败`,
      details: { error: error?.message || String(error) }
    })
  }
  try {
    await connection?.quit?.()
  } catch (error) {
    logger.warn({
      message: `关闭 ${label} Redis 连接失败`,
      details: { error: error?.message || String(error) }
    })
  }
}

module.exports = {
  closeBullResources
}
