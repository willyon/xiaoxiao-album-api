/*
 * @Author: zhangshouchang
 * @Date: 2024-12-30 23:44:21
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-12-30 23:44:30
 * @Description: File description
 */
const fs = require('fs')
const path = require('path')

const validators = {}
const files = fs.readdirSync(__dirname).filter((file) => file !== 'index.js')

files.forEach((file) => {
  const validatorName = path.basename(file, '.js')
  validators[validatorName] = require(`./${file}`)
})

module.exports = validators
