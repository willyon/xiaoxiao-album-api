/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-20 01:38:03
 * @Description: File description
 */
const { db } = require("../services/dbService");
const { getStartOrEndOfMonth } = require("../utils/formatTime");

// 创建表格
function createTableImages() {
  const createtablestmt = `
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bigPath TEXT,
        smallPath TEXT,
        creationDate TEXT,
        hash TEXT
      );
    `;
  db.prepare(createtablestmt).run();
}

//保存图片信息到数据库
const saveImageInfo = (() => {
  const stmt = db.prepare(`INSERT INTO images (bigPath, smallPath, creationDate, hash) VALUES (?, ?, ?, ?)`);
  return ({ bigPath, smallPath, creationDate, hash }) => {
    return new Promise((resolve, reject) => {
      try {
        stmt.run(bigPath, smallPath, creationDate, hash);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };
})();

// 根据 ID 查找图片
function findImageInfoById(id) {
  const stmt = db.prepare(`SELECT * FROM images WHERE id = ?`);
  try {
    stat.run(id);
  } catch (err) {
    console.log("通过图片ID获取图片信息发生错误：", err);
  }
}

// 获取所有图片信息
function getAllImageInfo() {
  const stmt = db.prepare(`SELECT * FROM images`);
  try {
    return stmt.all();
  } catch (err) {
    console.log("获取全部图片信息发生错误：", err);
  }
}

// 分页获取全部图片信息
let cachedAllTotal = null;
function getAllImageInfoByPage({ pageNo = 1, pageSize = 10 }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT * FROM images
    ORDER BY creationDate DESC   
    LIMIT ? OFFSET ?
  `);
  try {
    const pageData = dataQuery.all(pageSize, offset);
    // 如果缓存为空，则计算总条数并缓存
    if (cachedAllTotal === null) {
      const countQuery = db.prepare(`SELECT COUNT(*) AS total FROM images`);
      cachedAllTotal = countQuery.get().total;
    }
    return {
      data: pageData,
      total: cachedAllTotal,
    };
  } catch (err) {
    console.log("分页获取图片信息发生错误：", err);
  }
}

// 分页获取具体某个月图片信息 月份的total不必缓存
function getCertainMonthImageInfoByPage({ pageNo = 1, pageSize = 10, creationDate = 0 }) {
  let monthTotal = null;
  const offset = (pageNo - 1) * pageSize;
  // 有时间戳
  if (creationDate) {
    const monthStart = getStartOrEndOfMonth(creationDate, "start");
    const monthEnd = getStartOrEndOfMonth(creationDate, "end");
    console.log("月份时间戳：", monthStart, monthEnd);
    const dataQuery = db.prepare(`
    SELECT * FROM images
    WHERE creationDate >= ? AND creationDate < ? 
    ORDER BY creationDate DESC   
    LIMIT ? OFFSET ?
  `);
    try {
      const pageData = dataQuery.all(monthStart, monthEnd, pageSize, offset);
      // 如果缓存为空，则计算总条数并缓存
      const countQuery = db.prepare(`
        SELECT COUNT(*) AS total 
        FROM images
        WHERE creationDate >= ? AND creationDate < ? 
      `);
      monthTotal = countQuery.get(monthStart, monthEnd).total;
      return {
        data: pageData,
        total: monthTotal,
      };
    } catch (err) {
      console.log("分页获取图片信息发生错误：", err);
    }
  } else {
    // 没有时间戳
    const dataQuery = db.prepare(`
    SELECT * FROM images
    WHERE (creationDate IS NULL OR creationDate = '') 
    ORDER BY creationDate DESC   
    LIMIT ? OFFSET ?
  `);
    try {
      const pageData = dataQuery.all(pageSize, offset);
      // 如果缓存为空，则计算总条数并缓存
      const countQuery = db.prepare(`
        SELECT COUNT(*) AS total 
        FROM images
        WHERE (creationDate IS NULL OR creationDate = '') 
      `);
      monthTotal = countQuery.get().total;
      return {
        data: pageData,
        total: monthTotal,
      };
    } catch (err) {
      console.log("分页获取图片信息发生错误：", err);
    }
  }
}

module.exports = {
  createTableImages,
  saveImageInfo,
  findImageInfoById,
  getAllImageInfo,
  getAllImageInfoByPage,
  getCertainMonthImageInfoByPage,
};
