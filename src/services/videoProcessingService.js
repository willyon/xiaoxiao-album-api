/*
 * @Description: 视频处理服务 - 抽帧、元数据提取（ffprobe）
 * 依赖：系统需安装 FFmpeg、ffprobe
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const logger = require('../utils/logger')
const storageService = require('./storageService')

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe'

/**
 * 从 ffprobe 获取视频色彩元数据（用于正确抽帧）
 * MOV/QuickTime 常缺失或错误，导致 FFmpeg 默认按 BT.601 处理，产生惨白/发灰
 * 室外阳光视频常为 HDR（bt2020+HLG），需 tone mapping 才能正确转 SDR
 * @param {string} videoPath - 视频文件路径。
 * @returns {Promise<{ inColorMatrix: string, inRange: string, isHdr: boolean }>} 色彩元数据。
 */
async function getVideoColorMetadata(videoPath) {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_space,color_range,color_primaries,color_transfer',
      '-of',
      'json',
      videoPath
    ]
    const proc = require('child_process').spawn(FFPROBE_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (c) => (stdout += c.toString()))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ inColorMatrix: 'bt709', inRange: 'tv', isHdr: false })
        return
      }
      try {
        const data = JSON.parse(stdout)
        const s = data.streams?.[0] || {}
        const colorSpace = (s.color_space || '').toLowerCase()
        const colorRange = (s.color_range || '').toLowerCase()
        const primaries = (s.color_primaries || '').toLowerCase()
        const transfer = (s.color_transfer || '').toLowerCase()
        // scale 滤镜仅支持: auto, bt601, bt470, smpte170m, bt709, fcc, smpte240m, bt2020
        let inColorMatrix = 'bt709'
        if (colorSpace && ['bt709', 'bt601', 'smpte240m', 'bt2020', 'bt2020nc', 'bt2020ncl'].includes(colorSpace)) {
          inColorMatrix = colorSpace.includes('2020') ? 'bt2020' : colorSpace
        } else if (primaries && primaries.includes('2020')) {
          inColorMatrix = 'bt2020'
        }
        const inRange = colorRange === 'pc' || colorRange === 'full' ? 'pc' : 'tv'
        // HDR: bt2020 色彩空间 + HLG(arib-std-b67) 或 PQ(smpte2084) 传输
        const isHdr =
          inColorMatrix === 'bt2020' &&
          (transfer.includes('arib') || transfer.includes('smpte2084') || transfer.includes('hlg') || transfer.includes('pq'))
        resolve({ inColorMatrix, inRange, isHdr })
      } catch {
        resolve({ inColorMatrix: 'bt709', inRange: 'tv', isHdr: false })
      }
    })
    proc.on('error', () => resolve({ inColorMatrix: 'bt709', inRange: 'tv', isHdr: false }))
  })
}

/**
 * 从视频中提取首帧为 Buffer（PNG 格式，便于 Sharp 处理）
 * 色彩修正：显式指定输入色彩空间，避免 MOV 等格式因元数据缺失导致惨白
 * 参考：https://stackoverflow.com/questions/74350828, https://richardssam.github.io/ffmpeg-tests/ColorPreservation.html
 * @param {string} videoPath - 视频文件路径（绝对路径或相对路径）
 * @returns {Promise<Buffer>} 首帧图片 Buffer
 */
async function extractFirstFrame(videoPath) {
  const { inColorMatrix, inRange, isHdr } = await getVideoColorMetadata(videoPath)
  const tempDir = os.tmpdir()
  const tempFile = path.join(tempDir, `frame-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)

  return new Promise((resolve, reject) => {
    // SDR: 显式指定输入色彩空间。HDR: 需 tone mapping（依赖 libzimg/zscale）
    const scalePart = `scale=trunc(iw/2)*2:trunc(ih/2)*2:sws_flags=lanczos:in_color_matrix=${inColorMatrix}:in_range=${inRange}:out_color_matrix=bt709:out_range=pc`
    let vf = scalePart
    if (isHdr) {
      // HDR→SDR tone mapping。需 ffmpeg 编译时 --enable-libzimg（brew 预编译版无此支持）
      const hdrVf = `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2:sws_flags=lanczos`
      vf = hdrVf
    }
    let isRetry = false
    const runFfmpeg = (filterGraph) => {
      const a = ['-i', videoPath, '-vframes', '1', '-vf', filterGraph, '-f', 'image2', '-an', '-y', tempFile]
      const proc = spawn(FFMPEG_PATH, a, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      proc.on('close', (code) => {
        if (code !== 0) {
          if (!isRetry && isHdr && (stderr.includes('zscale') || stderr.includes('Invalid argument'))) {
            isRetry = true
            logger.warn({ message: 'HDR tonemap 需要 libzimg(zscale)，当前 ffmpeg 不支持，回退到 SDR 抽帧', details: { videoPath } })
            runFfmpeg(scalePart)
            return
          }
          fs.unlink(tempFile, () => {})
          reject(new Error(`ffmpeg extractFirstFrame failed with code ${code}: ${stderr.slice(-200)}`))
          return
        }
        fs.readFile(tempFile, (err, data) => {
          fs.unlink(tempFile, () => {})
          if (err) reject(new Error(`ffmpeg extractFirstFrame read failed: ${err.message}`))
          else resolve(data)
        })
      })
      proc.on('error', (err) => {
        fs.unlink(tempFile, () => {})
        reject(new Error(`ffmpeg spawn failed: ${err.message}`))
      })
    }

    runFfmpeg(vf)
  })
}

/**
 * 使用 ffprobe 获取视频元数据
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<{duration:number|null,codec:string|null,width:number|null,height:number|null,codedWidth:number|null,codedHeight:number|null,rotationDegrees:number,creationTime:number|null,gpsLatitude:number|null,gpsLongitude:number|null}>} 视频元数据。
 *   width/height 为考虑 rotation 后的显示尺寸；coded* 为码流内宽高
 */
async function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath]

    const proc = spawn(FFPROBE_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`))
        return
      }
      try {
        const data = JSON.parse(stdout)
        const result = _parseFfprobeOutput(data)
        resolve(result)
      } catch (err) {
        reject(new Error(`ffprobe parse failed: ${err.message}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`ffprobe spawn failed: ${err.message}`))
    })
  })
}

/**
 * ffprobe 视频流中的旋转角度（度），常见：tags.rotate 或 side_data Display Matrix
 * @param {object} videoStream - ffprobe 视频流对象。
 * @returns {number} 可为负值，与 FFmpeg 行为一致
 */
function _parseVideoRotationDegrees(videoStream) {
  if (!videoStream) return 0
  const tags = videoStream.tags || {}
  if (tags.rotate != null) {
    const n = parseInt(String(tags.rotate), 10)
    if (!isNaN(n)) return n
  }
  const list = videoStream.side_data_list
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item && item.rotation != null) {
        const n = parseInt(String(item.rotation), 10)
        if (!isNaN(n)) return n
      }
    }
  }
  return 0
}

/**
 * 按显示旋转得到用户观感上的宽高（与 EXIF 5–8 交换宽高一致：90°/270° 交换）
 * @param {number|null} codedWidth - 码流宽度。
 * @param {number|null} codedHeight - 码流高度。
 * @param {number} rotationDegrees - 旋转角度。
 * @returns {{codedWidth:number|null,codedHeight:number|null,displayWidth:number|null,displayHeight:number|null}} 显示尺寸结果。
 */
function _displayDimensionsFromRotation(codedWidth, codedHeight, rotationDegrees) {
  if (!codedWidth || !codedHeight) {
    return { codedWidth, codedHeight, displayWidth: codedWidth, displayHeight: codedHeight }
  }
  const r = ((rotationDegrees % 360) + 360) % 360
  const swap = r === 90 || r === 270
  if (swap) {
    return {
      codedWidth,
      codedHeight,
      displayWidth: codedHeight,
      displayHeight: codedWidth
    }
  }
  return { codedWidth, codedHeight, displayWidth: codedWidth, displayHeight: codedHeight }
}

/**
 * 解析 ffprobe JSON 输出
 * width/height 为「显示」尺寸（已考虑 rotation），与图片侧 displayWidth/displayHeight 语义一致
 * codedWidth/codedHeight 为码流内存储的像素框
 * @param {object} data - ffprobe JSON 输出对象。
 * @returns {{duration:number|null,codec:string|null,width:number|null,height:number|null,codedWidth:number|null,codedHeight:number|null,rotationDegrees:number,creationTime:number|null,gpsLatitude:number|null,gpsLongitude:number|null}} 标准化结果。
 */
function _parseFfprobeOutput(data) {
  const result = {
    duration: null,
    codec: null,
    width: null,
    height: null,
    codedWidth: null,
    codedHeight: null,
    rotationDegrees: 0,
    creationTime: null,
    gpsLatitude: null,
    gpsLongitude: null
  }

  // 时长：format.duration
  if (data.format && data.format.duration) {
    result.duration = parseFloat(data.format.duration)
  }

  // 视频流：取第一个 video 流
  const videoStream = data.streams?.find((s) => s.codec_type === 'video')
  if (videoStream) {
    result.codec = videoStream.codec_name || null
    const cw = videoStream.width ? parseInt(videoStream.width, 10) : null
    const ch = videoStream.height ? parseInt(videoStream.height, 10) : null
    result.codedWidth = cw
    result.codedHeight = ch
    const rotationDegrees = _parseVideoRotationDegrees(videoStream)
    result.rotationDegrees = rotationDegrees
    const { displayWidth, displayHeight } = _displayDimensionsFromRotation(cw, ch, rotationDegrees)
    result.width = displayWidth
    result.height = displayHeight

    // stream_tags.creation_time
    if (videoStream.tags?.creation_time) {
      result.creationTime = _parseCreationTime(videoStream.tags.creation_time)
    }
  }

  // format.tags.creation_time 或 com.apple.quicktime.creationdate
  if (!result.creationTime && data.format?.tags) {
    const tags = data.format.tags
    const ct = tags.creation_time || tags['com.apple.quicktime.creationdate']
    if (ct) {
      result.creationTime = _parseCreationTime(ct)
    }
  }

  // GPS：format.tags.location（格式如 +39.9042+116.4074/）
  if (data.format?.tags?.location) {
    const loc = _parseGpsLocation(data.format.tags.location)
    if (loc) {
      result.gpsLatitude = loc.latitude
      result.gpsLongitude = loc.longitude
    }
  }

  return result
}

/**
 * 解析 ISO 8601 或类似格式的 creation_time 为时间戳（毫秒）
 * @param {string} str - creation_time 字符串。
 * @returns {number|null} 时间戳或 null。
 */
function _parseCreationTime(str) {
  if (!str || typeof str !== 'string') return null
  try {
    // ISO 8601: 2024-08-15T14:30:25.000000Z
    const date = new Date(str)
    return isNaN(date.getTime()) ? null : date.getTime()
  } catch {
    return null
  }
}

/**
 * 解析 GPS location 字符串（如 +39.9042+116.4074/）
 * @param {string} str - GPS location 字符串。
 * @returns {{latitude:number,longitude:number}|null} 解析结果。
 */
function _parseGpsLocation(str) {
  if (!str || typeof str !== 'string') return null
  const match = str.match(/^([+-]?\d+\.?\d*)([+-]?\d+\.?\d*)/)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lon = parseFloat(match[2])
  if (isNaN(lat) || isNaN(lon)) return null
  return { latitude: lat, longitude: lon }
}

/**
 * 从视频抽首帧并按 extension 编码（与图片缩略图一致，默认 MEDIA_THUMBNAIL_EXTENSION / webp），写入存储
 * @param {string} videoPath - 视频路径
 * @param {string} targetStorageKey - 目标存储键
 * @param {{storeFile:(data:Buffer,key:string)=>Promise<any>}} storageAdapter - 存储适配器（需有 storeFile 方法）。
 * @param {{extension?:string}} [options]
 * @param {string} [options.extension] - 目标扩展名；未传则使用 process.env.MEDIA_THUMBNAIL_EXTENSION || "webp"
 * @returns {Promise<{ width: number, height: number }>} 生成后的缩略图尺寸。
 */
async function storeVideoThumbnail(videoPath, targetStorageKey, storageAdapter, options = {}) {
  const extension = options.extension ?? (process.env.MEDIA_THUMBNAIL_EXTENSION || 'webp')

  const frameBuffer = await extractFirstFrame(videoPath)
  if (!frameBuffer || frameBuffer.length === 0) {
    throw new Error('extractFirstFrame returned empty buffer')
  }

  const { data, width, height } = await storageService.processImageBuffer({
    buffer: frameBuffer,
    extension,
    quality: 65,
    resizeWidth: 600
  })

  await storageAdapter.storeFile(data, targetStorageKey)

  return {
    width,
    height
  }
}

module.exports = {
  getVideoMetadata,
  storeVideoThumbnail
}
