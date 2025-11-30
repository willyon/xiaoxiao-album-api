# 后端缺失实现清单

## ❌ 未实现的新增接口

以下接口在前端已定义，但**后端路由被注释，控制器方法未实现**：

### 1. Images 图片接口（5个未实现）

#### `GET /images/:imageId` - 获取单张图片详情

- **路由状态**：❌ 已注释（`imagesRoutes.js:35`）
- **控制器**：❌ `handleGetImageById` 不存在
- **说明**：标准 RESTful 操作，获取单个资源详情

#### `PUT /images/:imageId` - 完整更新图片信息

- **路由状态**：❌ 已注释（`imagesRoutes.js:38`）
- **控制器**：❌ `handleUpdateImage` 不存在
- **说明**：标准 RESTful 操作，完整更新资源

#### `PATCH /images/:imageId` - 部分更新图片信息

- **路由状态**：❌ 已注释（`imagesRoutes.js:41`）
- **控制器**：❌ `handlePatchImage` 不存在
- **说明**：⚠️ **重要**！`toggleImageFavorite` 前端使用了这个接口，但后端未实现
- **影响**：切换图片喜欢状态功能**无法正常工作**

#### `DELETE /images/:imageId` - 删除单张图片

- **路由状态**：❌ 已注释（`imagesRoutes.js:44`）
- **控制器**：❌ `handleDeleteImage` 不存在
- **说明**：标准 RESTful 操作，删除单个资源

#### `DELETE /images` - 批量删除图片

- **路由状态**：❌ 已注释（`imagesRoutes.js:47`）
- **控制器**：✅ `handleDeleteImages` **已存在**（在 `cleanupController.js` 中）
- **说明**：可以复用 `cleanupController.handleDeleteImages`，只需取消注释路由

### 2. Albums 相册接口（1个未实现）

#### `PATCH /albums/:albumId` - 部分更新相册信息

- **路由状态**：❌ 已注释（`albumRoutes.js:36`）
- **控制器**：❌ `handlePatchAlbum` 不存在
- **说明**：标准 RESTful 操作，部分更新资源

### 3. Upload Sessions 上传会话接口（1个未实现）

#### `DELETE /upload-sessions/:sessionId` - 删除上传会话

- **路由状态**：❌ 已注释（`uploadSessionRoutes.js:19`）
- **控制器**：❌ `handleDeleteSession` 不存在
- **说明**：标准 RESTful 操作，删除资源

### 4. Trash 回收站接口（2个未实现）

#### `POST /trash/:imageId/restore` - 恢复单张图片

- **路由状态**：❌ 已注释（`trashRoutes.js:24`）
- **控制器**：❌ `handleRestoreImage` 不存在
- **说明**：可以复用 `handleRestoreImages` 的逻辑，只需传入单个 imageId

#### `DELETE /trash/:imageId` - 永久删除单张图片

- **路由状态**：❌ 已注释（`trashRoutes.js:30`）
- **控制器**：❌ `handlePermanentlyDeleteImage` 不存在
- **说明**：可以复用 `handlePermanentlyDeleteImages` 的逻辑，只需传入单个 imageId

---

## ✅ 已实现或可复用的接口

### `GET /upload-sessions` - 获取上传会话列表

- **路由状态**：✅ 已实现（`uploadSessionRoutes.js:16`）
- **控制器**：✅ `handleGetActiveSession` 已实现，支持 `active` query param
- **说明**：通过 query params 可以获取所有会话或只获取活跃会话

### `DELETE /images` - 批量删除图片

- **路由状态**：❌ 已注释，但可以快速启用
- **控制器**：✅ `handleDeleteImages` 已存在（`cleanupController.js:64`）
- **建议**：取消注释路由，直接使用现有控制器

---

## 🚨 紧急需要实现的接口

### 1. `PATCH /images/:imageId` - 部分更新图片（喜欢状态）

**优先级：🔴 高**

**原因**：

- 前端 `toggleImageFavorite` 使用了这个接口
- 如果后端未实现，**切换图片喜欢状态功能无法工作**

**实现建议**：

```javascript
// src/controllers/imageController.js
async function handlePatchImage(req, res, next) {
  try {
    const { imageId } = req.params;
    const updates = req.body; // { favorite: true } 等
    const userId = req.user.userId;

    // 调用 service 更新图片
    const updatedImage = await imageService.patchImage({ userId, imageId, updates });

    res.sendResponse({ data: updatedImage });
  } catch (error) {
    next(error);
  }
}
```

**路由配置**：

```javascript
// src/routes/imagesRoutes.js
router.patch("/:imageId", handlePatchImage);
```

---

## 📋 实现优先级建议

### 高优先级（影响现有功能）

1. ✅ **`PATCH /images/:imageId`** - 切换喜欢状态功能需要
2. ✅ **`DELETE /images`** - 批量删除功能需要（只需取消注释）

### 中优先级（标准 RESTful 操作）

3. `GET /images/:imageId` - 获取单张图片详情
4. `DELETE /images/:imageId` - 删除单张图片
5. `PUT /images/:imageId` - 完整更新图片

### 低优先级（扩展功能）

6. `PATCH /albums/:albumId` - 部分更新相册
7. `DELETE /upload-sessions/:sessionId` - 删除上传会话
8. `POST /trash/:imageId/restore` - 恢复单张图片
9. `DELETE /trash/:imageId` - 永久删除单张图片

---

## 🔧 快速修复建议

### 1. 立即修复 `PATCH /images/:imageId`

这是最紧急的，因为前端已经在使用：

```javascript
// src/routes/imagesRoutes.js
const { handlePatchImage } = require("../controllers/imageController");
router.patch("/:imageId", handlePatchImage);
```

```javascript
// src/controllers/imageController.js
async function handlePatchImage(req, res, next) {
  try {
    const { imageId } = req.params;
    const updates = req.body;
    const userId = req.user.userId;

    // 如果更新的是 favorite，可以复用 toggleFavoriteImage 的逻辑
    if (updates.favorite !== undefined) {
      // 调用现有的 toggleFavoriteImage 逻辑
      // 或者实现新的更新逻辑
    }

    // 其他字段的更新逻辑
    const updatedImage = await imageService.patchImage({ userId, imageId, updates });
    res.sendResponse({ data: updatedImage });
  } catch (error) {
    next(error);
  }
}
```

### 2. 快速启用 `DELETE /images`

只需取消注释并导入控制器：

```javascript
// src/routes/imagesRoutes.js
const { handleDeleteImages } = require("../controllers/cleanupController");
router.delete("/", handleDeleteImages);
```

---

## 📝 总结

- **未实现的接口**：9 个
- **可快速启用**：1 个（`DELETE /images`，只需取消注释）
- **紧急需要实现**：1 个（`PATCH /images/:imageId`，影响喜欢功能）
- **标准 CRUD 接口**：7 个（可以逐步实现）

**建议**：先实现 `PATCH /images/:imageId`，然后启用 `DELETE /images`，其他接口可以按需实现。
