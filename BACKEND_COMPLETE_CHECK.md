# 后端接口完整检查清单

## 根据前端 api.js 检查后端实现情况

### ✅ 已实现的接口

#### Auth 认证接口

- ✅ `POST /auth/session` - createSession (handleLoginOrRegister)
- ✅ `GET /auth/me` - getCurrentUser (handleCheckLoginStatus)
- ✅ `GET /auth/verify-email` - verifyEmail (handleVerifyEmail)
- ✅ `POST /auth/verify-email/resend` - resendVerificationEmail (handleResendVerificationEmail)
- ✅ `DELETE /auth/session` - logout (handleLogoutUser)

#### Images 图片接口

- ✅ `POST /images/check-exists` - checkFileExists (handleCheckFileExists)
- ✅ `POST /images/upload/signature` - getUploadSignature (handleGetUploadSignature)
- ✅ `POST /images` - createImages (handlePostImages)
- ✅ `GET /images` - getImages (handleGetAllByPage)
- ✅ `GET /images/:imageId/download` - downloadImage (handleDownloadSingleImage)
- ✅ `POST /images/download` - downloadImages (handleDownloadBatchImages)

#### Albums 相册接口

- ✅ `GET /albums` - getAlbums (queryAlbums)
- ✅ `POST /albums` - createAlbum (createAlbum)
- ✅ `GET /albums/:albumId` - getAlbumById (getAlbumById)
- ✅ `PUT /albums/:albumId` - updateAlbum (updateAlbum)
- ✅ `DELETE /albums/:albumId` - deleteAlbum (deleteAlbum)
- ✅ `GET /albums/:albumId/images` - getAlbumImages (queryAlbumPhotos)
- ✅ `POST /albums/:albumId/images` - addImagesToAlbum (addImagesToAlbum)
- ✅ `DELETE /albums/:albumId/images` - removeImagesFromAlbum (removeImagesFromAlbum)
- ✅ `PUT /albums/:albumId/cover` - setAlbumCover (setAlbumCover)

#### Upload Sessions 上传会话接口

- ✅ `POST /upload-sessions` - createUploadSession (handleCreateSession)
- ✅ `GET /upload-sessions` - getUploadSessions (handleGetActiveSession，支持 active query param)

#### Search 搜索接口

- ✅ `POST /search/images` - searchImages (handleSearchImages)
- ✅ `GET /search/suggestions` - getSearchSuggestions (handleGetSearchSuggestions)
- ✅ `GET /search/filters` - getFilterOptions (handleGetFilterOptionsPaginated)

#### Cleanup 清理接口

- ✅ `GET /cleanup/summary` - getCleanupSummary (handleGetSummary)
- ✅ `GET /cleanup/groups` - getCleanupGroups (handleGetGroups)

#### Trash 回收站接口

- ✅ `GET /trash/summary` - getTrashSummary (handleGetTrashSummary)
- ✅ `GET /trash` - getTrashImages (handleGetDeletedImages)
- ✅ `POST /trash/restore` - restoreImages (handleRestoreImages)
- ✅ `DELETE /trash` - permanentlyDeleteImages (handlePermanentlyDeleteImages)
- ✅ `DELETE /trash/all` - clearTrash (handleClearTrash)

---

## ❌ 缺失的接口（需要实现）

### 1. Images 图片接口（5个）

#### `GET /images/:imageId` - 获取单张图片详情

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：需要实现 `getImageById`
- **模型层**：需要实现 `selectImageById`（或复用 `getImageStorageInfo` 但需要扩展）

#### `PUT /images/:imageId` - 完整更新图片信息

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：需要实现 `updateImage`
- **模型层**：已有 `updateImageMetadata`，可能需要扩展

#### `PATCH /images/:imageId` - 部分更新图片信息 ⚠️ 紧急

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：需要实现 `patchImage`
- **模型层**：需要实现部分更新逻辑
- **说明**：前端 `toggleImageFavorite` 使用了此接口，必须实现

#### `DELETE /images/:imageId` - 删除单张图片

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：可以复用 `cleanupService.deleteImages` 逻辑
- **模型层**：已有 `markImagesDeleted`

#### `DELETE /images` - 批量删除图片

- **路由状态**：❌ 已注释
- **控制器**：✅ 已存在 (`cleanupController.handleDeleteImages`)
- **服务层**：✅ 已存在 (`cleanupService.deleteImages`)
- **说明**：只需取消注释路由并导入控制器

### 2. Albums 相册接口（1个）

#### `PATCH /albums/:albumId` - 部分更新相册信息

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：需要实现 `patchAlbum`
- **模型层**：可以复用 `updateAlbum` 逻辑，但只更新提供的字段

### 3. Upload Sessions 上传会话接口（1个）

#### `DELETE /upload-sessions/:sessionId` - 删除上传会话

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：需要实现 `deleteSession`
- **说明**：需要删除 Redis 中的会话数据

### 4. Trash 回收站接口（2个）

#### `POST /trash/:imageId/restore` - 恢复单张图片

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：可以复用 `trashService.restoreImages` 逻辑，传入单个 imageId
- **模型层**：已有 `restoreImages`

#### `DELETE /trash/:imageId` - 永久删除单张图片

- **路由状态**：❌ 已注释
- **控制器**：❌ 不存在
- **服务层**：可以复用 `trashService.permanentlyDeleteImages` 逻辑，传入单个 imageId
- **模型层**：已有相关逻辑

---

## 📋 实现优先级

### 🔴 高优先级（影响现有功能）

1. **`PATCH /images/:imageId`** - 切换喜欢状态功能需要
2. **`DELETE /images`** - 批量删除功能需要（只需取消注释）

### 🟡 中优先级（标准 RESTful 操作）

3. `GET /images/:imageId` - 获取单张图片详情
4. `DELETE /images/:imageId` - 删除单张图片
5. `PUT /images/:imageId` - 完整更新图片

### 🟢 低优先级（扩展功能）

6. `PATCH /albums/:albumId` - 部分更新相册
7. `DELETE /upload-sessions/:sessionId` - 删除上传会话
8. `POST /trash/:imageId/restore` - 恢复单张图片
9. `DELETE /trash/:imageId` - 永久删除单张图片

---

## 🔍 需要检查的旧接口逻辑

### Search 接口

- ⚠️ `handleAdvancedSearch` 是否还需要？前端已合并到 `searchImages`
- 建议：检查是否可以移除 `handleAdvancedSearch`，统一使用 `handleSearchImages`
