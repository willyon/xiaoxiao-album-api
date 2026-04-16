/*
 * 收藏（喜欢）：Controller 仅通过本模块访问，不直调 model。
 * 与 appSettingsService 同为薄转发；此处只导出 albumModel 的收藏相关方法，并做对外命名（…Favorites）。
 */
const albumModel = require('../models/albumModel')

module.exports = {
  toggleFavoriteMedia: albumModel.toggleFavoriteMedia
}
