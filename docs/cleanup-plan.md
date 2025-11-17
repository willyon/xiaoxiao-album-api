# 智能图片清理功能规划

## 目标概述
- 提供重复图、相似图、模糊图的智能清理能力。
- 上传后自动分析并生成分组，前端可批量操作，放大预览统一复用 `PhotoPreview.vue`。

---

## 基线能力
- Python AI 服务已有 `/analyze_person`，返回人脸/人物信息。
- Node 服务队列：`imageUploadQueue → imageMetaQueue → searchIndexQueue`，`processFaceRecognition` 会写入人脸字段与高质量 embedding。
- 数据层：`images` 存储拍摄时间、颜色主题、人脸信息；`face_embeddings` 保存高质量人脸特征。
- 前端：Pinia 管理相册，已有上传重复校验，放大预览组件 `PhotoPreview.vue`。

---

## 新增与调整（已确认）
1. **Python AI 服务新增接口**：`POST /analyze_cleanup`
   - 输出 `perceptual_hash`、`sharpness_score`、`aesthetic_score`、`image_embedding` 等指标。
2. **Node 新增队列**：`cleanupQueue`
   - 独立 Worker 负责调用 `/analyze_cleanup`、写库、更新清理分组。
3. **前端放大预览**：统一继续使用 `PhotoPreview.vue`。

---

## 数据结构规划
- `images` 表新增字段：
  - `perceptual_hash` TEXT
  - `sharpness_score` REAL
  - `aesthetic_score` REAL
  - `cleanup_scanned_at` INTEGER
  - `duplicate_group_id` INTEGER
  - `similarity_cluster_id` INTEGER
  - 新索引：`idx_images_user_sharpness`、`idx_images_user_dup_group`、`idx_images_user_cleanup_scanned`
- 新表 `cleanup_groups`：`id`、`user_id`、`group_type`、`primary_image_id`、`score`、`member_count`、时间戳
- 新表 `cleanup_group_members`：`group_id`、`image_id`、`rank_score`、`similarity`、`is_recommended_keep`

---

## Python `/analyze_cleanup` 设计
- 输入：图片二进制（复用现有解码流程）。
- 输出：
  - `perceptual_hash`（pHash / wavelet hash）
  - `sharpness_score`（Laplacian / Tenengrad 归一化分）
  - `aesthetic_score`（NIMA 或 LAION 预测 0-1）
  - `image_embedding`（OpenCLIP/ViT ONNX 向量）
- 模型与指标在单例中初始化，注意多格式支持与单元测试。

---

## Node 服务改造
### 队列与 Worker
- 新建 `cleanupQueue.js`、`cleanupWorker.js`，Worker 内调用 `cleanupIngestor.processCleanup(job)`。
- 触发：上传完成后入队；提供脚本 `scripts/enqueueCleanupForAll.js` 做历史回填。

### `cleanupIngestor`
1. 获取图片（高清图优先）。
2. 调用 `/analyze_cleanup`。
3. 更新 `images` 新字段。
4. 调用 `cleanupGroupingService`，生成/更新分组。

### `cleanupGroupingService`
- **重复图**：`perceptual_hash` 完全一致 → 同组，选美学分/清晰度最高者保留。
- **相似图**：基于 `image_embedding` 余弦相似度（≥0.92），初期可全量计算，后续视需求接入 ANN。
- **模糊图**：`sharpness_score < 阈值`（如 0.2）且非推荐保留项。
- 写入 `cleanup_groups`、`cleanup_group_members`。

### API
- `GET /cleanup/summary`：返回各类型数量、预估释放空间。
- `GET /cleanup/groups`：分页返回分组（按 `type` 过滤）。
- `POST /cleanup/groups/:id/actions`：处理批量操作（删除所选、保留所选、忽略分组）。
- `POST /cleanup/scan`：手动触发扫描任务。

---

## 前端实现
- 新建“智能清理中心”页面：
  - 顶部 Summary 卡片。
  - Tab：重复 / 相似 / 模糊。
  - 分组卡片显示推荐保留与成员缩略图。
  - 批量操作，点击缩略图调用 `PhotoPreview.vue`。
  - Pinia `cleanupStore` 维护列表、选择与加载状态。
  - 扫描中展示进度/提示。
- 国际化新增 `cleanup` 相关文案。

---

## 实施步骤
1. 确认 UI/阈值/回收站策略。
2. 落库迁移脚本，扩展 `initTableModel.js`。
3. Python 实现 `/analyze_cleanup` 并部署。
4. Node 新增 `cleanupQueue`、`cleanupWorker`、`cleanupIngestor`、`cleanupGroupingService`、API。
5. 编写历史数据回填脚本。
6. 开发前端页面和 store。
7. 联调与验收（样本集验证准确性）。
8. 根据性能需要引入 ANN 或缓存。
9. 灰度上线并监控日志。

---

## 风险与 TODO
- 大模型体积与加载时间，需要部署规划。
- 历史数据回填耗时，需要进度监控。
- 删除策略需确认是否实现回收站。
- 如果数据量增长，需提前评估向量检索方案。

---

## 后续扩展方向
- 支持截图、文档识别等更多清理类别。
- 结合用户行为调整推荐逻辑。
- 提供周期性提醒与自动清理建议。
