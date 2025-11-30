# 后端 API 重构清单

## 需要修改的接口对照表

### 1. Auth 认证接口 (`src/routes/authRoutes.js`)

| 当前接口                             | 重构后接口                       | HTTP方法 | 说明                               |
| ------------------------------------ | -------------------------------- | -------- | ---------------------------------- |
| `POST /auth/loginOrRegister`         | `POST /auth/session`             | POST     | ✅ 需要修改                        |
| `GET /auth/checkLoginStatus`         | `GET /auth/me`                   | GET      | ✅ 需要修改                        |
| `POST /auth/logoutUser`              | `DELETE /auth/session`           | DELETE   | ✅ 需要修改                        |
| `GET /auth/verifyEmail`              | `GET /auth/verify-email`         | GET      | ✅ 需要修改（路径改为 kebab-case） |
| `POST /auth/resendVerificationEmail` | `POST /auth/verify-email/resend` | POST     | ✅ 需要修改                        |
| `POST /auth/refreshToken`            | `POST /auth/refreshToken`        | POST     | ⚠️ 保持不变（内部接口）            |

### 2. Images 图片接口 (`src/routes/imagesRoutes.js`)

| 当前接口                          | 重构后接口                      | HTTP方法 | 说明                                             |
| --------------------------------- | ------------------------------- | -------- | ------------------------------------------------ |
| `POST /images/postImages`         | `POST /images`                  | POST     | ✅ 需要修改                                      |
| `POST /images/checkFileExists`    | `POST /images/check-exists`     | POST     | ✅ 需要修改（路径改为 kebab-case）               |
| `POST /images/getUploadSignature` | `POST /images/upload/signature` | POST     | ✅ 需要修改                                      |
| `POST /images/queryAllByPage`     | `GET /images`                   | GET      | ✅ 需要修改（POST → GET，参数改为 query params） |
| `GET /images/download/:imageId`   | `GET /images/:imageId/download` | GET      | ✅ 需要修改（路径调整）                          |
| `POST /images/download/batch`     | `POST /images/download`         | POST     | ✅ 需要修改                                      |
| -                                 | `GET /images/:imageId`          | GET      | ✅ 需要新增（获取单张图片详情）                  |
| -                                 | `PUT /images/:imageId`          | PUT      | ✅ 需要新增（完整更新图片）                      |
| -                                 | `PATCH /images/:imageId`        | PATCH    | ✅ 需要新增（部分更新图片，如喜欢状态）          |
| -                                 | `DELETE /images/:imageId`       | DELETE   | ✅ 需要新增（删除单张图片）                      |
| -                                 | `DELETE /images`                | DELETE   | ✅ 需要新增（批量删除图片）                      |

### 3. Albums 相册接口 (`src/routes/albumRoutes.js`)

| 当前接口                                    | 重构后接口                       | HTTP方法 | 说明                                              |
| ------------------------------------------- | -------------------------------- | -------- | ------------------------------------------------- |
| `POST /images/albums/:type`                 | `GET /albums?type=:type`         | GET      | ✅ 需要修改（POST → GET，type 改为 query param）  |
| `POST /images/albums/:type/:albumId/photos` | `GET /albums/:albumId/images`    | GET      | ✅ 需要修改（POST → GET，移除 type 参数）         |
| `POST /images/albums`                       | `POST /albums`                   | POST     | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| `GET /images/albums/:albumId`               | `GET /albums/:albumId`           | GET      | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| `PUT /images/albums/:albumId`               | `PUT /albums/:albumId`           | PUT      | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| -                                           | `PATCH /albums/:albumId`         | PATCH    | ✅ 需要新增（部分更新相册）                       |
| `DELETE /images/albums/:albumId`            | `DELETE /albums/:albumId`        | DELETE   | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| `POST /images/albums/:albumId/images`       | `POST /albums/:albumId/images`   | POST     | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| `DELETE /images/albums/:albumId/images`     | `DELETE /albums/:albumId/images` | DELETE   | ✅ 需要修改（路径从 /images/albums 改为 /albums） |
| `POST /images/albums/:albumId/set-cover`    | `PUT /albums/:albumId/cover`     | PUT      | ✅ 需要修改（POST → PUT，路径简化）               |
| `POST /images/albums/favorite/toggle`       | `PATCH /images/:imageId`         | PATCH    | ✅ 需要修改（改为更新图片资源，而不是相册子资源） |

### 4. Upload Sessions 上传会话接口 (`src/routes/uploadSessionRoutes.js`)

| 当前接口                       | 重构后接口                           | HTTP方法 | 说明                                   |
| ------------------------------ | ------------------------------------ | -------- | -------------------------------------- |
| `POST /uploads/sessions`       | `POST /upload-sessions`              | POST     | ✅ 需要修改（路径改为 kebab-case）     |
| `GET /uploads/sessions/active` | `GET /upload-sessions?active=true`   | GET      | ✅ 需要修改（active 改为 query param） |
| -                              | `DELETE /upload-sessions/:sessionId` | DELETE   | ✅ 需要新增（删除上传会话）            |

### 5. Search 搜索接口 (`src/routes/searchRoutes.js`)

| 当前接口                                      | 重构后接口                          | HTTP方法 | 说明                                               |
| --------------------------------------------- | ----------------------------------- | -------- | -------------------------------------------------- |
| `POST /images/search/images`                  | `POST /search/images`               | POST     | ✅ 需要修改（路径从 /images/search 改为 /search）  |
| `POST /images/search/advanced`                | `POST /search/images?advanced=true` | POST     | ✅ 需要修改（合并到统一接口，用 query param 区分） |
| `GET /images/search/suggestions`              | `GET /search/suggestions`           | GET      | ✅ 需要修改（路径从 /images/search 改为 /search）  |
| `GET /images/search/filter-options-paginated` | `GET /search/filters`               | GET      | ✅ 需要修改（路径和命名都改变）                    |

### 6. Cleanup 清理接口 (`src/routes/cleanupRoutes.js`)

| 当前接口                      | 重构后接口                                   | HTTP方法 | 说明                                                |
| ----------------------------- | -------------------------------------------- | -------- | --------------------------------------------------- |
| `GET /images/cleanup/summary` | `GET /cleanup/summary`                       | GET      | ✅ 需要修改（路径从 /images/cleanup 改为 /cleanup） |
| `GET /images/cleanup/groups`  | `GET /cleanup/groups`                        | GET      | ✅ 需要修改（路径从 /images/cleanup 改为 /cleanup） |
| `POST /images/cleanup/delete` | `DELETE /images` 或 `DELETE /cleanup/images` | DELETE   | ✅ 需要修改（POST → DELETE，推荐使用 /images 接口） |

### 7. Trash 回收站接口 (`src/routes/trashRoutes.js`)

| 当前接口                                | 重构后接口                                              | HTTP方法 | 说明                                            |
| --------------------------------------- | ------------------------------------------------------- | -------- | ----------------------------------------------- |
| `GET /images/trash/summary`             | `GET /trash/summary`                                    | GET      | ✅ 需要修改（路径从 /images/trash 改为 /trash） |
| `GET /images/trash/list`                | `GET /trash`                                            | GET      | ✅ 需要修改（路径和命名都改变）                 |
| `POST /images/trash/restore`            | `POST /trash/restore` 或 `POST /trash/:imageId/restore` | POST     | ✅ 需要修改（路径从 /images/trash 改为 /trash） |
| `POST /images/trash/permanently-delete` | `DELETE /trash/:imageId` 或 `DELETE /trash`             | DELETE   | ✅ 需要修改（POST → DELETE，路径改变）          |
| `POST /images/trash/clear`              | `DELETE /trash/all`                                     | DELETE   | ✅ 需要修改（POST → DELETE，路径改变）          |

## 路由注册修改 (`server.js`)

需要修改路由注册：

- `/images` 路由需要拆分：部分改为 `/albums`，部分改为 `/search`，部分改为 `/cleanup`，部分改为 `/trash`
- 新增 `/upload-sessions` 路由（从 `/uploads` 改为 `/upload-sessions`）
- 新增 `/search` 路由（从 `/images/search` 独立出来）
- 新增 `/cleanup` 路由（从 `/images/cleanup` 独立出来）
- 新增 `/trash` 路由（从 `/images/trash` 独立出来）

## 注意事项

1. **参数格式变化**：
   - `POST /images/queryAllByPage` → `GET /images`：参数从 body 改为 query params
   - `POST /images/albums/:type` → `GET /albums?type=:type`：type 从路径参数改为 query param
   - `POST /images/albums/:type/:albumId/photos` → `GET /albums/:albumId/images`：移除 type 参数

2. **HTTP 方法变化**：
   - 多个 POST 接口改为 GET（查询操作）
   - 多个 POST 接口改为 DELETE（删除操作）
   - 新增 PATCH 方法支持（部分更新）

3. **路径层级优化**：
   - `/images/albums` → `/albums`（相册独立出来）
   - `/images/search` → `/search`（搜索独立出来）
   - `/images/cleanup` → `/cleanup`（清理独立出来）
   - `/images/trash` → `/trash`（回收站独立出来）

4. **控制器方法可能需要调整**：
   - GET 请求的参数从 `req.body` 改为 `req.query`
   - DELETE 请求可能需要支持 body（批量删除场景）
