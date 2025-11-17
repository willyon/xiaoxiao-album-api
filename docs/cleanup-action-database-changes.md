# 清理操作数据库变更说明

本文档详细说明执行删除或保留操作时，数据库中哪些表的哪些字段会发生变化。

## 字段值说明

### `cleanup_processed_at` 字段

- **类型**: INTEGER (时间戳，毫秒)
- **值**:
  - `NULL`: 未处理，会显示在清理列表中
  - `时间戳`: 已处理，不再显示在清理列表中
- **用途**: 通用字段，用于标记图片是否已在清理模块中被处理（保留操作）

### `deleted_at` 字段

- **类型**: INTEGER (时间戳，毫秒)
- **值**:
  - `NULL`: 未删除，图片正常显示
  - `时间戳`: 已软删除，图片移至垃圾箱
- **用途**: 软删除标记，图片不会真正从数据库删除

### `is_recommended_keep` 字段 (cleanup_group_members 表)

- **类型**: INTEGER (0 或 1)
- **值**:
  - `0`: 不推荐保留
  - `1`: 推荐保留
- **用途**: 标记分组中的图片是否被用户选择保留

---

## 删除操作 (`action: 'delete_selected'`)

### 所有类型（duplicate/similar/blurry/all）

#### 1. `images` 表

- **字段**: `deleted_at`
- **操作**: UPDATE
- **值**: 设置为当前时间戳（毫秒）
- **SQL**:
  ```sql
  UPDATE images
  SET deleted_at = ?
  WHERE id IN (...)
  ```

### 仅分组类型（duplicate/similar）

#### 2. `cleanup_group_members` 表

- **操作**: DELETE
- **条件**: 删除指定图片ID的记录
- **SQL**:
  ```sql
  DELETE FROM cleanup_group_members
  WHERE image_id IN (...)
  ```

#### 3. `cleanup_groups` 表（自动刷新）

- **字段**: `member_count`, `updated_at`, `deleted_at`（如果成员数为0）
- **操作**: UPDATE（通过 `refreshGroupStats`）
- **说明**:
  - 更新 `member_count` 为当前剩余成员数
  - 更新 `updated_at` 为当前时间戳
  - 如果 `member_count` 变为 0，设置 `deleted_at` 为当前时间戳

---

## 保留操作 (`action: 'keep_selected'`)

### 分组类型（duplicate/similar）

#### 1. `cleanup_group_members` 表

- **字段**: `is_recommended_keep`, `updated_at`
- **操作**: UPDATE
- **值**:
  - `is_recommended_keep` = 1
  - `updated_at` = 当前时间戳
- **SQL**:
  ```sql
  UPDATE cleanup_group_members
  SET is_recommended_keep = 1, updated_at = ?
  WHERE group_id = ? AND image_id IN (...)
  ```

#### 2. `cleanup_groups` 表（自动刷新）

- **字段**: `updated_at`
- **操作**: UPDATE（通过 `refreshGroupStats`）
- **说明**: 更新 `updated_at` 为当前时间戳

### 模糊图片类型（blurry）

#### 1. `images` 表

- **字段**: `cleanup_processed_at`
- **操作**: UPDATE
- **值**: 设置为当前时间戳（毫秒）
- **SQL**:
  ```sql
  UPDATE images
  SET cleanup_processed_at = ?
  WHERE id IN (...)
  ```
- **效果**: 图片不再出现在模糊图片列表中（因为查询条件包含 `cleanup_processed_at IS NULL`）

### 所有图片类型（all，未来扩展）

- 目前暂无特殊处理

---

## 操作流程图

```
删除操作 (delete_selected)
├── images.deleted_at = 当前时间戳
├── [如果是 duplicate/similar]
│   ├── cleanup_group_members: DELETE 记录
│   └── cleanup_groups: 刷新统计（member_count, updated_at, deleted_at）
└── [如果是 blurry/all]
    └── 仅更新 images.deleted_at

保留操作 (keep_selected)
├── [如果是 duplicate/similar]
│   ├── cleanup_group_members.is_recommended_keep = 1
│   ├── cleanup_group_members.updated_at = 当前时间戳
│   └── cleanup_groups.updated_at = 当前时间戳
├── [如果是 blurry]
│   └── images.cleanup_processed_at = 当前时间戳
└── [如果是 all]
    └── 暂无处理
```

---

## 查询影响

### 模糊图片查询

查询条件包含 `cleanup_processed_at IS NULL`，所以：

- `cleanup_processed_at = NULL`: 会显示在模糊列表中
- `cleanup_processed_at = 时间戳`: 不会显示在模糊列表中

### 分组查询

- 已删除的图片（`deleted_at IS NOT NULL`）不会出现在分组中
- 已保留的图片（`is_recommended_keep = 1`）仍然在分组中，但会被标记为"推荐保留"

### 相册查询

- 已删除的图片（`deleted_at IS NOT NULL`）不会出现在正常相册中，但会出现在垃圾箱中
- `cleanup_processed_at` 不影响相册显示，只影响清理模块的列表
