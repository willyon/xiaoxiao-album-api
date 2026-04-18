/*
 * @Author: zhangshouchang
 * @Date: 2025-01-23
 * @Description: 图片下载 HTTP 控制器（业务逻辑见 downloadService）
 */
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const logger = require('../utils/logger')
const downloadService = require('../services/downloadService')
const asyncHandler = require('../utils/asyncHandler')
const { parsePositiveIntParam, requireNonEmptyIdArray, throwInvalidParametersError } = require('../utils/requestParams')

const {
  DOWNLOAD_BATCH_MAX,
  getSingleMediaDownloadData,
  createBatchMediaZipArchive,
  buildBatchZipDownloadFileName
} = downloadService

/**
 * 单张图片下载
 * GET /images/download/:mediaId
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleDownloadSingleMedia(req, res) {
  const { userId } = req?.user
  const mediaId = parsePositiveIntParam(req.params.mediaId)

  let buffer
  let fileName
  let contentType
  try {
    const data = await getSingleMediaDownloadData(userId, mediaId)
    buffer = data.buffer
    fileName = data.fileName
    contentType = data.contentType
  } catch (error) {
    if (error.message === '图片不存在' || error.message === '图片文件不存在') {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: 'error'
      })
    }
    throw error
  }

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
  res.setHeader('Content-Length', buffer.length)
  res.send(buffer)
}

/**
 * 批量图片下载（ZIP）
 * POST /images/download/batch
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @param {import('express').NextFunction} next - 错误传递函数。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function runDownloadBatchMedias(req, res, next) {
  const { userId } = req?.user
  const { mediaIds } = req.body

  if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
    throwInvalidParametersError({ messageType: 'error' })
  }

  if (mediaIds.length > DOWNLOAD_BATCH_MAX) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.DOWNLOAD_BATCH_LIMIT_EXCEEDED,
      messageType: 'warning',
      details: { max: DOWNLOAD_BATCH_MAX }
    })
  }

  let archive
  try {
    archive = await createBatchMediaZipArchive(userId, requireNonEmptyIdArray(mediaIds))
  } catch (error) {
    if (error.message === '未找到任何图片' || error.message === '图片ID列表为空') {
      throw new CustomError({
        httpStatus: 404,
        messageCode: ERROR_CODES.RESOURCE_NOT_FOUND,
        messageType: 'error'
      })
    }
    throw error
  }

  const zipFileName = buildBatchZipDownloadFileName()

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFileName)}"`)

  archive.pipe(res)

  archive.on('error', (err) => {
    logger.error({
      message: 'ZIP归档创建失败',
      details: { error: err.message }
    })
    if (!res.headersSent) {
      next(
        new CustomError({
          httpStatus: 500,
          messageCode: ERROR_CODES.SERVER_ERROR,
          messageType: 'error'
        })
      )
    }
  })

  archive.finalize()
}

module.exports = {
  handleDownloadSingleMedia: asyncHandler(handleDownloadSingleMedia),
  handleDownloadBatchMedias: asyncHandler(runDownloadBatchMedias)
}
