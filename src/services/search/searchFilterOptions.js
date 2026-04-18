/**
 * 搜索筛选项服务层：对外暴露分页筛选项能力，隔离 controller 与 model 的直接耦合。
 */
const searchModel = require('../../models/mediaModel')

/**
 * 分页获取筛选项（城市/年份/月份/星期），支持 mediaType 与 scope 条件。
 * 这里作为服务层薄封装，便于后续追加参数校验、缓存与监控埋点。
 *
 * @param {object} params - 查询参数。
 * @returns {{list:any[], total:number}} 分页筛选项结果。
 */
function getFilterOptionsPaginated(params) {
  return searchModel.getFilterOptionsPaginated(params)
}

module.exports = {
  getFilterOptionsPaginated
}
