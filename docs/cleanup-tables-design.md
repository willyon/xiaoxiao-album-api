# 清理模块表设计说明

## 表结构总览

### 1. `cleanup_groups` 表

- **用途**：记录重复/相似图片的分组信息
- **适用类型**：duplicate, similar
- **字段**：id, user_id, group_type, primary_image_id, member_count, total_size_bytes, updated_at, deleted_at

### 2. `cleanup_group_members` 表

- **用途**：记录分组中的成员图片及推荐保留标记
- **适用类型**：duplicate, similar
- **关键字段**：
  - `is_recommended_keep`: 0/1，标记是否被用户选择保留
  - `rank_score`: 排序分数
  - `similarity`: 相似度

### 3. `cleanup_processed_images` 表

- **用途**：记录模糊图片的"已保留"状态
- **适用类型**：blurry, all（未来扩展）
- **为什么需要**：
  - duplicate/similar 已经有 `cleanup_group_members.is_recommended_keep` 来标记保留
  - blurry 没有分组表，需要此表来记录"已保留"状态
- **注意**：此表只记录"保留"操作，不记录"删除"操作

---

## 图片状态判断

### 1. **正常状态**（未处理）

- `images.deleted_at IS NULL`
- 对于 duplicate/similar：`cleanup_group_members.is_recommended_keep = 0` 或不存在
- 对于 blurry：`cleanup_processed_images` 表中无记录

### 2. **软删除状态**

- `images.deleted_at IS NOT NULL`（时间戳）
- 图片在垃圾箱中，可以恢复
- 相关文件仍在存储中，未删除

### 3. **保留状态**

#### duplicate/similar 类型：

- `images.deleted_at IS NULL`
- `cleanup_group_members.is_recommended_keep = 1`
- 图片仍在分组中，但标记为"推荐保留"

#### blurry 类型：

- `images.deleted_at IS NULL`
- `cleanup_processed_images` 表中有记录（cleanup_type = 'blurry'）
- 图片不再出现在模糊列表中

### 4. **真正删除**（物理删除）

- 从 `images` 表中物理 DELETE 记录
- 删除存储中的相关文件（原图、高清图、缩略图）
- **目前系统未实现此功能**

---

## 操作对表的影响

### 删除操作 (`action: 'delete_selected'`)

**所有类型统一：**

- `images.deleted_at = 时间戳`（软删除）

**仅 duplicate/similar 额外：**

- `cleanup_group_members`: DELETE 记录
- `cleanup_groups`: 刷新统计

### 保留操作 (`action: 'keep_selected'`)

**duplicate/similar：**

- `cleanup_group_members.is_recommended_keep = 1`
- 不需要 `cleanup_processed_images` 表

**blurry：**

- `cleanup_processed_images`: INSERT 记录（cleanup_type = 'blurry'）
- 需要此表，因为没有分组表

---

## 总结

- **duplicate/similar**：使用 `cleanup_groups` + `cleanup_group_members` 表，通过 `is_recommended_keep` 标记保留
- **blurry**：使用 `cleanup_processed_images` 表记录保留状态（因为没有分组表）
- **删除操作**：统一通过 `images.deleted_at` 标记（软删除）
- **真正删除**：物理删除记录和文件（目前未实现）
