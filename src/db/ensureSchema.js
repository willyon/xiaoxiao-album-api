const { db } = require('./index')
const bcrypt = require('bcrypt')
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

function shouldSeedDesktopLocalUser() {
  return String(process.env.DESKTOP_LOCAL_MODE ?? '').trim().toLowerCase() === 'true'
}

function ensureDesktopLocalBootstrapUser() {
  if (!shouldSeedDesktopLocalUser()) return

  const email = String(process.env.DESKTOP_LOCAL_USER_EMAIL ?? '')
    .trim()
    .toLowerCase()
  if (!email) return

  const existing = db.prepare('SELECT id, verified_status FROM users WHERE email = ?').get(email)
  if (existing) {
    db.prepare("UPDATE users SET verified_status = 'active', verification_token = NULL WHERE id = ?").run(existing.id)
    logger.info({ message: '[schema] desktop local bootstrap user already exists', details: { email, userId: existing.id } })
    return
  }

  const seedPassword = process.env.DESKTOP_LOCAL_USER_PASSWORD || 'DesktopLocalUser#2026'
  const passwordHash = bcrypt.hashSync(seedPassword, 10)
  const result = db
    .prepare("INSERT INTO users (email, password, verified_status, verification_token) VALUES (?, ?, 'active', NULL)")
    .run(email, passwordHash)

  logger.info({
    message: '[schema] seeded desktop local bootstrap user',
    details: { email, userId: result.lastInsertRowid }
  })
}

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
    ensureDesktopLocalBootstrapUser()
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
