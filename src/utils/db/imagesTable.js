/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 14:21:05
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-30 15:56:15
 * @Description: File description
 */
module.exports = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bigPath TEXT,
      smallPath TEXT,
      creationDate TEXT
    );
  `);
};
