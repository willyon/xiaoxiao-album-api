# 图片状态判断说明

## 当前设计分析

### 删除操作 (`action: 'delete_selected'`)

- **所有类型统一**：更新 `images.deleted_at = 时间戳`（软删除）
- **分组类型额外**：从 `cleanup_group_members` 表删除记录

### 保留操作 (`action: 'keep_selected'`)

- **duplicate/similar**：更新 `cleanup_group_members.is_recommended_keep = 1`
- **blurry**：在 `cleanup_processed_images` 表中插入记录

---

## 如何判断图片状态

### 1. **正常状态**（未处理）

- `images.deleted_at IS NULL`
- `cleanup_group_members.is_recommended_keep = 0` 或不存在（分组类型）
- `cleanup_processed_images` 表中无记录（blurry类型）

### 2. **软删除状态**

- `images.deleted_at IS NOT NULL`（时间戳）
- 图片在垃圾箱中，可以恢复

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

- 目前系统没有这个功能
- 如果未来需要，会从 `images` 表中物理删除记录

---

## 问题：cleanup_processed_images 表是否需要记录操作类型？

### 当前设计

- `cleanup_processed_images` 表只记录"保留"操作
- 删除操作通过 `images.deleted_at` 标记

### 是否需要添加 `action_type` 字段？

**选项1：不添加（当前设计）**

- 优点：简单，删除已经通过 `deleted_at` 标记
- 缺点：语义不够清晰，需要查两个地方

**选项2：添加 `action_type` 字段**

- 字段：`action_type` TEXT ('keep' | 'delete')
- 优点：语义清晰，可以统一记录所有操作
- 缺点：删除操作会同时更新 `deleted_at` 和 `cleanup_processed_images`，有冗余

---

## 推荐方案

### 方案A：保持当前设计（推荐）

- `cleanup_processed_images` 表只记录"保留"操作
- 删除操作通过 `images.deleted_at` 标记
- **判断逻辑**：
  - 软删除：`images.deleted_at IS NOT NULL`
  - 保留（blurry）：`cleanup_processed_images` 表中有记录
  - 保留（duplicate/similar）：`cleanup_group_members.is_recommended_keep = 1`

### 方案B：添加 `action_type` 字段

- 在 `cleanup_processed_images` 表中添加 `action_type` 字段
- 删除和保留都记录在这个表中
- **判断逻辑**：
  - 软删除：`cleanup_processed_images.action_type = 'delete'` 或 `images.deleted_at IS NOT NULL`
  - 保留：`cleanup_processed_images.action_type = 'keep'`

---

## 我的建议

**保持当前设计（方案A）**，因为：

1. 删除操作已经通过 `deleted_at` 统一标记，不需要额外记录
2. `cleanup_processed_images` 表专门用于记录"保留"操作，语义清晰
3. 避免冗余：删除操作不需要同时更新两个地方

但如果未来需要更详细的审计日志，可以考虑方案B。
