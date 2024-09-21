/*
 * @Author: zhangshouchang
 * @Date: 2024-09-05 17:01:09
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-22 02:54:07
 * @Description: File description
 */
const { db } = require("../services/dbService");
const { getStartOrEndOfTime } = require("../utils/formatTime");

// 创建表格
function createTableImages() {
  const createtablestmt = `
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bigImageUrl TEXT,
        smallImageUrl TEXT,
        creationDate INTEGER,
        hash TEXT
      );
    `;
  db.prepare(createtablestmt).run();
}

//保存图片信息到数据库
const saveImageInfo = (() => {
  // 测试可用
  // createTableImages();
  const stmt = db.prepare(`INSERT INTO images (bigImageUrl, smallImageUrl, creationDate, hash) VALUES (?, ?, ?, ?)`);
  return ({ bigImageUrl, smallImageUrl, creationDate, hash }) => {
    return new Promise((resolve, reject) => {
      try {
        stmt.run(bigImageUrl, smallImageUrl, creationDate, hash);
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

// 分页获取具体某个时间段(某月、某年)图片信息
let cachedCertainTimeRangeTotal = null;
function getCertainTimeRangeImageInfoByPage({ pageNo = 1, pageSize = 10, creationDate = 0, dataRange = "" }) {
  if (pageNo === 1) {
    cachedCertainTimeRangeTotal = null;
  }
  const offset = (pageNo - 1) * pageSize;
  // 有时间戳
  if (creationDate) {
    const startTime = getStartOrEndOfTime(creationDate, "start", dataRange);
    const endTime = getStartOrEndOfTime(creationDate, "end", dataRange);
    console.log("相册时间戳：", startTime, endTime);
    const dataQuery = db.prepare(`
      SELECT * FROM images
      WHERE creationDate >= ? AND creationDate < ? 
      ORDER BY creationDate DESC   
      LIMIT ? OFFSET ?
    `);
    try {
      const pageData = dataQuery.all(startTime, endTime, pageSize, offset);
      // 如果缓存为空，则计算总条数并缓存
      if (!cachedCertainTimeRangeTotal) {
        const countQuery = db.prepare(`
          SELECT COUNT(*) AS total 
          FROM images
          WHERE creationDate >= ? AND creationDate < ? 
      `);
        cachedCertainTimeRangeTotal = countQuery.get(startTime, endTime).total;
      }
      return {
        data: pageData,
        total: cachedCertainTimeRangeTotal,
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
      if (!cachedCertainTimeRangeTotal) {
        const countQuery = db.prepare(`
          SELECT COUNT(*) AS total 
          FROM images
          WHERE (creationDate IS NULL OR creationDate = '') 
      `);
        cachedCertainTimeRangeTotal = countQuery.get().total;
      }
      return {
        data: pageData,
        total: cachedCertainTimeRangeTotal,
      };
    } catch (err) {
      console.log("分页获取图片信息发生错误：", err);
    }
  }
}

// 分页获取按年份分组图片目录数据
let cachedYearCatalogTotal = null;
function getYearCatalogInfoByPage({ pageNo = 1, pageSize = 10 }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT
      CASE
        WHEN creationDate IS NULL OR creationDate = '' THEN 'unknown'
        ELSE strftime('%Y', creationDate / 1000, 'unixepoch')
      END AS timeOfGroup,

      (SELECT smallImageUrl FROM images AS i2
        WHERE (strftime('%Y', i2.creationDate / 1000, 'unixepoch') = strftime('%Y', i1.creationDate / 1000, 'unixepoch')
        OR (i2.creationDate IS NULL OR i2.creationDate = ''))
      ORDER BY i2.creationDate DESC LIMIT 1
      ) AS latestImageUrl,

      (SELECT creationDate FROM images AS i2
        WHERE (strftime('%Y', i2.creationDate / 1000, 'unixepoch') = strftime('%Y', i1.creationDate / 1000, 'unixepoch')
        OR (i2.creationDate IS NULL OR i2.creationDate = ''))
      ORDER BY i2.creationDate DESC LIMIT 1
      ) AS creationDate,

      COUNT(*) AS imageCount

    FROM images AS i1
    GROUP BY timeOfGroup
    ORDER BY
      CASE
        WHEN timeOfGroup = 'unknown' THEN 1
        ELSE 0
      END,
      timeOfGroup DESC
    LIMIT ? OFFSET ?;
  `);
  try {
    const pageData = dataQuery.all(pageSize, offset);
    // 如果缓存为空，则计算总条数并缓存
    if (cachedYearCatalogTotal === null) {
      const countQuery = db.prepare(`
        SELECT COUNT(DISTINCT CASE 
          WHEN creationDate IS NULL OR creationDate = '' THEN 'unknown' 
          ELSE strftime('%Y', creationDate / 1000, 'unixepoch')
        END) AS groupCount
        FROM images;
      `);
      cachedYearCatalogTotal = countQuery.get().groupCount;
    }
    return {
      data: pageData,
      total: cachedYearCatalogTotal,
    };
  } catch (err) {
    console.log("分页获取图片信息发生错误：", err);
  }
}

// 分页获取按月份分组图片目录数据
let cachedMonthCatalogTotal = null;
function getMonthCatalogInfoByPage({ pageNo = 1, pageSize = 10 }) {
  const offset = (pageNo - 1) * pageSize;
  const dataQuery = db.prepare(`
    SELECT
      CASE
        WHEN creationDate IS NULL OR creationDate = '' THEN 'unknown'
        ELSE strftime('%Y-%m', creationDate / 1000, 'unixepoch')
      END AS timeOfGroup,

      (SELECT smallImageUrl FROM images AS i2
        WHERE (strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch') = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch')
        OR (i2.creationDate IS NULL OR i2.creationDate = ''))
      ORDER BY i2.creationDate DESC LIMIT 1
      ) AS latestImageUrl,

      (SELECT creationDate FROM images AS i2
        WHERE (strftime('%Y-%m', i2.creationDate / 1000, 'unixepoch') = strftime('%Y-%m', i1.creationDate / 1000, 'unixepoch')
        OR (i2.creationDate IS NULL OR i2.creationDate = ''))
      ORDER BY i2.creationDate DESC LIMIT 1
      ) AS creationDate,

      COUNT(*) AS imageCount

    FROM images AS i1
    GROUP BY timeOfGroup
    ORDER BY
      CASE
        WHEN timeOfGroup = 'unknown' THEN 1
        ELSE 0
      END,
      timeOfGroup DESC
    LIMIT ? OFFSET ?;
  `);
  try {
    const pageData = dataQuery.all(pageSize, offset);
    // 如果缓存为空，则计算总条数并缓存
    if (cachedMonthCatalogTotal === null) {
      const countQuery = db.prepare(`
        SELECT COUNT(DISTINCT CASE 
          WHEN creationDate IS NULL OR creationDate = '' THEN 'unknown' 
          ELSE strftime('%Y-%m', creationDate / 1000, 'unixepoch')
        END) AS groupCount
        FROM images;
      `);
      cachedMonthCatalogTotal = countQuery.get().groupCount;
    }
    return {
      data: pageData,
      total: cachedMonthCatalogTotal,
    };
  } catch (err) {
    console.log("分页获取图片信息发生错误：", err);
  }
}

module.exports = {
  createTableImages,
  saveImageInfo,
  findImageInfoById,
  getAllImageInfo,
  getAllImageInfoByPage,
  getCertainTimeRangeImageInfoByPage,
  getYearCatalogInfoByPage,
  getMonthCatalogInfoByPage,
};
