/*
 * @Author: zhangshouchang
 * @Date: 2025-01-XX
 * @Description: 相册路由
 */
const express = require('express')
const router = express.Router()
const {
  createAlbum,
  getAlbumById,
  updateAlbum,
  deleteAlbum,
  getCustomAlbums,
  getRecentAlbums,
  addMediasToAlbum,
  removeMediasFromAlbum,
  setAlbumCover,
  restoreAlbumCover
} = require('../controllers/albumController')

// ========== 相册列表接口 ========== //
// 获取自定义相册列表
router.get('/', getCustomAlbums)

// 获取最近使用的相册（须在 /:albumId 之前注册）
router.get('/recent', getRecentAlbums)

// ========== 相册 CRUD 接口 ========== //
// 创建相册
router.post('/', createAlbum)

// 获取相册详情
router.get('/:albumId', getAlbumById)

// 完整更新相册
router.put('/:albumId', updateAlbum)

// 删除相册
router.delete('/:albumId', deleteAlbum)

// ========== 相册媒体管理接口 ========== //
// 添加媒体到相册
router.post('/:albumId/media', addMediasToAlbum)

// 从相册中移除媒体
router.delete('/:albumId/media', removeMediasFromAlbum)

// 设置相册封面图片
router.put('/:albumId/cover', setAlbumCover)

// 恢复相册默认封面
router.delete('/:albumId/cover', restoreAlbumCover)

module.exports = router
