const { db } = require('./index')
const logger = require('../utils/logger')
const {
  createTableUsers,
  createTableAppConfig,
  createTableMedia,
  createTableMediaFaceEmbeddings,
  createTableMediaEmbeddings,
  createTableAlbumsMediaVersion,
  createTableAlbumMedia,
  createTableFaceClustersMediaVersion,
  createTableFaceClusterRepresentatives,
  createTableFaceClusterMeta,
  createTableSimilarGroupsMediaVersion,
  createTableSimilarGroupMembersMediaVersion,
  createTableMediaSearch,
  createTableMediaSearchFts,
  createTableMediaSearchTerms
} = require('../models/initTableModel')

/**
 * 启动时幂等建表：首次安装自动建库建表；已有库仅补齐缺失对象。
 * @returns {void}
 */
function ensureSchemaInitialized() {
  const statements = [
    createTableUsers,
    createTableAppConfig,
    createTableMedia,
    createTableMediaFaceEmbeddings,
    createTableMediaEmbeddings,
    createTableAlbumsMediaVersion,
    createTableAlbumMedia,
    createTableFaceClustersMediaVersion,
    createTableFaceClusterRepresentatives,
    createTableFaceClusterMeta,
    createTableSimilarGroupsMediaVersion,
    createTableSimilarGroupMembersMediaVersion,
    createTableMediaSearch,
    createTableMediaSearchFts,
    createTableMediaSearchTerms
  ]

  try {
    db.prepare('BEGIN TRANSACTION').run()
    for (const createFn of statements) createFn()
    db.prepare('COMMIT').run()
    logger.info({ message: '[schema] ensureSchemaInitialized completed' })
  } catch (error) {
    try {
      db.prepare('ROLLBACK').run()
    } catch (_rollbackErr) {
      // ignore rollback secondary failure
    }
    logger.error({ message: '[schema] ensureSchemaInitialized failed', details: { error: error.message } })
    throw error
  }
}

module.exports = {
  ensureSchemaInitialized
}
