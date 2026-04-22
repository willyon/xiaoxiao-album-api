/*
 * @Author: zhangshouchang
 * @Date: 2024-08-30 16:46:37
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2025-08-18 10:33:42
 * @Description: Optimized Server Configuration
 */

// 加载.env文件中的环境变量
require('dotenv').config()
const path = require('path')
const logger = require('./src/utils/logger')

const express = require('express')
const cors = require('cors')
const { getRedisClient } = require('./src/services/redisClient')
const initGracefulShutdown = require('./src/utils/gracefulShutdown')

const { closeMediaUploadQueue } = require('./src/queues/mediaUploadQueue')
const { closeMediaMetaQueue } = require('./src/queues/mediaMetaQueue')
const { closeMediaAnalysisQueue } = require('./src/queues/mediaAnalysisQueue')
const { closeCloudCaptionQueue } = require('./src/queues/cloudCaptionQueue')
const { closeMapRegeoQueue } = require('./src/queues/mapRegeoQueue')

// 应用服务安全中间件
const xss = require('xss')
const cookieParser = require('cookie-parser')
// const helmet = require("helmet");
// const rateLimit = require("express-rate-limit");

//中间件
const { responseHandler } = require('./src/middlewares/responseHandler')
const { errorHandler } = require('./src/middlewares/errorHandler')
const authMiddleware = require('./src/middlewares/authMiddleware')

// 导入业务路由
const authRoutes = require('./src/routes/authRoutes')
const mediaRoutes = require('./src/routes/mediaRoutes')
const albumRoutes = require('./src/routes/albumRoutes')
const searchRoutes = require('./src/routes/searchRoutes')
const trashRoutes = require('./src/routes/trashRoutes')
const aliyunOssCallbackRoutes = require('./src/routes/aliyunOssCallbackRoutes')
const uploadSessionRoutes = require('./src/routes/uploadSessionRoutes')
const faceClusterRoutes = require('./src/routes/faceClusterRoutes')
const timelineRoutes = require('./src/routes/timelineRoutes')
const settingsRoutes = require('./src/routes/settingsRoutes')
const { progressStream } = require('./src/controllers/mediaProcessingProgressController')
const { getLocations } = require('./src/controllers/locationsController')

// ========================== 创建Express实例，设置端口号 ========================== //

const app = express()
const PORT = process.env.PORT || 3000

// ========================== 安全中间件 ========================== //

// 提升Express应用安全性 通过设置http响应头来防止一些常见的网页安全攻击 如xss、点击劫持等
// app.use(helmet());
//允许图片、视频等静态资源可以被别的网页通过 <img>、<video>、<iframe> 等标签加载。
// app.use(helmet({ crossOriginResourcePolicy: false }));

// 防止xss攻击 自动过滤用户提交的数据里的恶意脚本。
app.use((req, res, next) => {
  if (req.body) {
    req.body = JSON.parse(xss(JSON.stringify(req.body)))
  }
  next()
})

// ========================== 基础中间件 ========================== //

// CORS跨域配置 - 允许前端访问后端API
// 开发环境：前端统一 http://127.0.0.1:5173（Vite dev / preview 与 Electron）；直连 :3000 的 EventSource 等依赖此白名单
// 生产环境：禁止跨域反射，同源或网关反代场景不受影响
const DEV_CORS_ORIGINS = new Set(['http://127.0.0.1:5173'])

app.use(
  cors({
    // 开发环境：仅放行上列 Origin；勿用 http://localhost:5173 打开前端以免与 Cookie/CORS 不一致
    origin:
      process.env.NODE_ENV === 'development'
        ? (origin, callback) => {
            if (!origin || DEV_CORS_ORIGINS.has(origin)) {
              callback(null, true)
            } else {
              callback(null, false)
            }
          }
        : false,

    // 允许跨域请求携带认证信息（cookies、Authorization头等）
    credentials: true,

    // 指定允许的HTTP方法
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],

    // 指定允许的请求头
    // Content-Type: 设置请求内容类型（JSON、表单等）
    // Authorization: 发送JWT认证令牌
    // X-Accept-Language: 发送语言偏好设置
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Accept-Language']
  })
)

// 注册JSON请求体解析
app.use(express.json())

// 添加自动解析cookie的中间件
app.use(cookieParser())

// 注册表单解析 解析form-data或URL参数 { extended: true }表示使用第三方qs模块 以便解析嵌套对象
app.use(express.urlencoded({ extended: true }))

// 注册自定义响应格式中间件 必须在所有路由之前挂载
app.use(responseHandler)

// ========================== 静态资源中间件 ========================== //

// 提供静态文件访问服务
app.use('/storage-local', express.static(path.join(__dirname, 'storage-local')))

// ========================== 业务路由注册 ========================== //

// 注册认证路由
app.use('/api/auth', authRoutes)

// 注册阿里云OSS回调路由 - 不需要鉴权（保持原路径，因为这是外部回调）
app.use('/aliyunOss', aliyunOssCallbackRoutes)

// 注册媒体业务路由+鉴权中间件(authMiddleware)
app.use('/api/media', [authMiddleware], mediaRoutes)

// 注册相册路由+鉴权中间件(authMiddleware)
app.use('/api/albums', [authMiddleware], albumRoutes)

// 注册搜索路由+鉴权中间件(authMiddleware)
app.use('/api/search', [authMiddleware], searchRoutes)

// 注册回收站路由+鉴权中间件(authMiddleware)
app.use('/api/trash', [authMiddleware], trashRoutes)

// 注册上传会话管理路由+鉴权中间件(authMiddleware)
app.use('/api/upload-sessions', [authMiddleware], uploadSessionRoutes)

// 注册SSE进度推送路由 - 不需要鉴权（EventSource无法发送认证头）
app.get('/api/progress/stream', progressStream)

// 注册人脸聚类路由+鉴权中间件(authMiddleware)
app.use('/api/face-clusters', [authMiddleware], faceClusterRoutes)

// 注册时间轴路由+鉴权中间件(authMiddleware)
app.use('/api/timeline', [authMiddleware], timelineRoutes)

// 注册地点路由+鉴权中间件(authMiddleware)
app.get('/api/locations', authMiddleware, getLocations)

// 注册应用设置路由+鉴权中间件(authMiddleware)
app.use('/api/settings', [authMiddleware], settingsRoutes)

// ========================== 错误处理中间件 ========================== //

// 注册错误处理器 必须在所有路由之后挂载
app.use(errorHandler)

// ========================== 启动服务器 ========================== //

const server = app.listen(PORT, () => {
  logger.info({ message: `服务已启用：http://localhost:${PORT}` })
})

// 应用服务进程退出前进行的操作
initGracefulShutdown({
  server,
  getRedisClient,
  extraClosers: [
    // 关闭 BullMQ 的 Queue 及其底层连接（API 进程只负责入队）
    async () => closeMediaUploadQueue(),
    async () => closeMediaMetaQueue(),
    async () => closeMediaAnalysisQueue(),
    async () => closeCloudCaptionQueue(),
    async () => closeMapRegeoQueue()
  ]
})
