#!/usr/bin/env node

/*
 * 数据库初始化脚本
 * 用于在服务器上创建必要的数据库表
 */

// 获取脚本所在目录的绝对路径
const path = require("path");
const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..");

// 设置工作目录为项目根目录
process.chdir(projectRoot);

require("dotenv").config();
const { createTableUsers, createTableImages, addStorageTypeColumn } = require(path.join(projectRoot, "src", "models", "initTableModel"));

async function initDatabase() {
  try {
    console.log("🚀 开始初始化数据库...");

    // 检查数据库文件是否存在
    const fs = require("fs");
    const path = require("path");
    const dbPath = path.resolve(__dirname, "../database.db");

    if (fs.existsSync(dbPath)) {
      console.log("📊 数据库文件已存在，检查表结构...");

      // 检查表是否存在
      const { db } = require("../src/services/dbService");
      const usersTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      const imagesTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'").get();

      if (usersTableExists && imagesTableExists) {
        console.log("✅ 数据库表已存在，跳过初始化");
        process.exit(0);
      }
    }

    // 创建users表
    console.log("📝 创建users表...");
    createTableUsers();
    console.log("✅ users表创建成功");

    // 创建images表
    console.log("📝 创建images表...");
    createTableImages();
    console.log("✅ images表创建成功");

    console.log("🎉 数据库初始化完成！");
    process.exit(0);
  } catch (error) {
    console.error("❌ 数据库初始化失败:", error.message);
    process.exit(1);
  }
}

initDatabase();
