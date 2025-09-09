#!/usr/bin/env node

/*
 * 数据库管理脚本
 * 用于查看和管理 SQLite 数据库
 */

require("dotenv").config();
const { db } = require("../src/services/dbService");

// 命令行参数解析
const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
📊 数据库管理工具

使用方法：
  node scripts/db-manager.js <命令> [参数]

命令：
  tables                    # 显示所有表
  users [limit]             # 查看用户数据（可选限制数量）
  images [limit]            # 查看图片数据（可选限制数量）
  count <table>             # 统计表记录数
  query <sql>               # 执行自定义 SQL 查询
  schema <table>            # 显示表结构
  help                      # 显示帮助信息

示例：
  node scripts/db-manager.js tables
  node scripts/db-manager.js users 10
  node scripts/db-manager.js count images
  node scripts/db-manager.js query "SELECT * FROM users WHERE email LIKE '%@gmail.com'"
  node scripts/db-manager.js schema users
`);
}

function showTables() {
  try {
    const tables = db
      .prepare(
        `
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name NOT LIKE 'sqlite_%'
        `,
      )
      .all();

    console.log("📋 数据库表列表：");
    tables.forEach((table) => {
      const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
      console.log(`  📄 ${table.name} (${count.count} 条记录)`);
    });
  } catch (error) {
    console.error("❌ 获取表列表失败:", error.message);
  }
}

function showUsers(limit = 10) {
  try {
    const users = db
      .prepare(
        `
            SELECT id, email, verifiedStatus, createdAt 
            FROM users 
            ORDER BY createdAt DESC 
            LIMIT ?
        `,
      )
      .all(limit);

    console.log(`👥 用户数据 (最近 ${limit} 条)：`);
    console.table(users);
  } catch (error) {
    console.error("❌ 获取用户数据失败:", error.message);
  }
}

function showImages(limit = 10) {
  try {
    const images = db
      .prepare(
        `
            SELECT id, user_id, image_hash, original_storage_key, high_res_storage_key, thumbnail_storage_key,
                   creation_date, year_key, month_key, storage_type
            FROM images 
            ORDER BY id DESC 
            LIMIT ?
        `,
      )
      .all(limit);

    console.log(`🖼️ 图片数据 (最近 ${limit} 条)：`);
    console.table(images);
  } catch (error) {
    console.error("❌ 获取图片数据失败:", error.message);
  }
}

function countRecords(tableName) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
    console.log(`📊 表 ${tableName} 共有 ${count.count} 条记录`);
  } catch (error) {
    console.error("❌ 统计失败:", error.message);
  }
}

function executeQuery(sql) {
  try {
    const result = db.prepare(sql).all();
    console.log("🔍 查询结果：");
    console.table(result);
  } catch (error) {
    console.error("❌ 查询失败:", error.message);
  }
}

function showSchema(tableName) {
  try {
    const schema = db.prepare(`PRAGMA table_info(${tableName})`).all();
    console.log(`🏗️ 表 ${tableName} 的结构：`);
    console.table(schema);
  } catch (error) {
    console.error("❌ 获取表结构失败:", error.message);
  }
}

// 主逻辑
switch (command) {
  case "tables":
    showTables();
    break;
  case "users":
    const userLimit = parseInt(args[1]) || 10;
    showUsers(userLimit);
    break;
  case "images":
    const imageLimit = parseInt(args[1]) || 10;
    showImages(imageLimit);
    break;
  case "count":
    if (!args[1]) {
      console.error("❌ 请指定表名");
      process.exit(1);
    }
    countRecords(args[1]);
    break;
  case "query":
    if (!args[1]) {
      console.error("❌ 请提供 SQL 查询语句");
      process.exit(1);
    }
    executeQuery(args[1]);
    break;
  case "schema":
    if (!args[1]) {
      console.error("❌ 请指定表名");
      process.exit(1);
    }
    showSchema(args[1]);
    break;
  case "help":
  case "--help":
  case "-h":
    showHelp();
    break;
  default:
    console.error("❌ 未知命令:", command);
    showHelp();
    process.exit(1);
}

// 关闭数据库连接
db.close();
