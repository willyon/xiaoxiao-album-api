/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:00:57
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-04 22:38:11
 * @Description: File description
 */
const Database = require("better-sqlite3");
const path = require("path");

// 创建并导出数据库连接
const db = new Database(path.resolve(__dirname, "../../database.db"));

// 开启外键支持
db.pragma("foreign_keys = ON");

//用于执行查询的函数
// function runQuery(query, params = []) {
//   const stmt = db.prepare(query);
//   return stmt.run(...params);
// }

module.exports = { db };
