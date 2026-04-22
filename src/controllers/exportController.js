/*
 * @Author: zhangshouchang
 * @Date: 2025-01-23
 * @Description: 图片导出 HTTP 控制器（业务逻辑见 exportService）
 */
const CustomError = require('../errors/customError')
const { ERROR_CODES } = require('../constants/messageCodes')
const logger = require('../utils/logger')
const exportService = require('../services/exportService')
const asyncHandler = require('../utils/asyncHandler')
const { parsePositiveIntParam, requireNonEmptyIdArray, throwInvalidParametersError } = require('../utils/requestParams')

const {
  EXPORT_BATCH_MAX,
  getSingleMediaExportData,
  createBatchMediaZipArchive,
  buildBatchZipExportFileName
} = exportService

/**
 * 单张图片导出
 * GET /:mediaId/export（见 mediaRoutes）
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function handleExportSingleMedia(req, res) {
  const { userId } = req?.user
  const mediaId = parsePositiveIntParam(req.params.mediaId)

  let buffer
  let fileName
  let contentType
  try {
    const data = await getSingleMediaExportData(userId, mediaId)
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
 * 批量图片导出（ZIP）
 * POST /export（见 mediaRoutes）
 * @param {import('express').Request} req - 请求对象。
 * @param {import('express').Response} res - 响应对象。
 * @param {import('express').NextFunction} next - 错误传递函数。
 * @returns {Promise<void>} 处理完成后无返回值。
 */
async function runExportBatchMedias(req, res, next) {
  const { userId } = req?.user
  const { mediaIds } = req.body

  if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
    throwInvalidParametersError({ messageType: 'error' })
  }

  if (mediaIds.length > EXPORT_BATCH_MAX) {
    throw new CustomError({
      httpStatus: 400,
      messageCode: ERROR_CODES.EXPORT_BATCH_LIMIT_EXCEEDED,
      messageType: 'warning',
      details: { max: EXPORT_BATCH_MAX }
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

  const zipFileName = buildBatchZipExportFileName()

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
  handleExportSingleMedia: asyncHandler(handleExportSingleMedia),
  handleExportBatchMedias: asyncHandler(runExportBatchMedias)
}
