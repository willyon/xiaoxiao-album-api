/*
 * @Description: 时间轴路由
 */
const express = require('express')
const router = express.Router()
const { getTimelineAlbums } = require('../controllers/timelineController')

router.get('/', getTimelineAlbums)

module.exports = router
