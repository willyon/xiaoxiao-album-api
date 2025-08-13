/*
 * @Author: zhangshouchang
 * @Date: 2024-09-17 15:05:27
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-13 09:15:50
 * @Description: File description
 */
const { deleteTableUsers, createTableUsers } = require("../src/models/initTableModel");

//⚠️注意：由于images做了外键映射到users表的id 所以要删除users数据前 要先删掉images中对应id的数据 否则用户表中对应id的用户无法删除

//删表
deleteTableUsers();
// 建表
createTableUsers();
