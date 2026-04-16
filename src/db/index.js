/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:57
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 22:38:11
 * @Description: SQLite 数据库连接（基础设施层）
 */
const Database = require('better-sqlite3')
const path = require('path')

// 创建并导出数据库连接
const db = new Database(path.resolve(__dirname, '../../database.db'))

// 开启外键支持
db.pragma('foreign_keys = ON')

// 优化 SQLite 性能配置
// WAL 模式：提高并发性能，减少锁竞争
db.pragma('journal_mode = WAL')
// 同步模式：NORMAL 平衡性能和安全性
db.pragma('synchronous = NORMAL')
// 缓存大小：64MB，提高查询性能
db.pragma('cache_size = -65536')
// 临时存储：内存，提高临时表操作性能
db.pragma('temp_store = MEMORY')

module.exports = { db }
