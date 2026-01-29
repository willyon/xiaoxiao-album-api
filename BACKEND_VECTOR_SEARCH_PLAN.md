## 向量搜索升级方案（阶段 B，使用 hnswlib）

### 1. 目标与现状

- **目标**：在不引入外部向量数据库的前提下，引入 ANN 索引（hnswlib），避免每次请求都把几千条向量通过 HTTP 传给 Python 暴力扫，从而：
  - 显著降低单次查询的 CPU / 内存 / 网络开销；
  - 为后续「大厂级」架构（阶段 C：Milvus / ES / OpenSearch 等）打基础。
- **现状**：
  - 已有：图片上传后会在 Node 侧计算 SigLIP2 图像向量，并写入 `image_embeddings` 表（SQLite）。
  - 目前：每次搜索时，Node 通过 `getImageEmbeddingsByUserId` 把当前用户的所有候选向量读出来，通过 HTTP 发送给 Python `/search_by_vector`，Python 用 NumPy 做精确余弦相似度排序。
  - 问题：候选多时（几千张图 × 1152 维），一次请求的 **JSON 体积** 和 **矩阵计算** 都比较重，容易拖慢整机。

> 阶段 B 的核心思想：**把「候选向量全集」常驻在 Python 内存中的 hnswlib 索引里，在线查询只发「query 向量」，不再发「一坨候选」。**

---

### 2. 整体架构变化（相比当前方案）

- **保持不变的部分**：
  - 文本编码接口：`POST /encode_text`（SigLIP2 文本 → 1152 维向量）。
  - 向量搜索接口的调用方式：Node 仍然是「query 向量 + userId」去找相似图片，然后和 FTS 结果做 RRF 合并。
  - `image_embeddings` 表作为**真源数据**仍然存在（方便重建索引、做离线分析）。

- **新增 / 变化的组件**：
  - Python 侧引入 `hnswlib`，在内存中维护 **ANN 索引**：
    - 索引类型：`space='cosine'`，`dim=1152`。
    - 存储内容：每个向量的内部 `label` 映射到 `(image_id, user_id)`。
  - 新的「索引管理」服务层（Python）：
    - 启动时从数据库批量加载 `image_embeddings`，构建或加载 hnswlib 索引。
    - 提供方法：`search(user_id, query_vector, top_k)`，内部根据 user_id 做过滤。
  - Node 侧改造：
    - 不再调用 `/search_by_vector` 时传 `candidates`，而是只传 `query_vector` 和 `user_id`；
    - 或者保留老接口，新增 `POST /ann_search` 仅接受 `query_vector` + `user_id`。

---

### 3. hnswlib 设计细节

#### 3.1 索引组织方式

为简单起步，先采用 **单索引 + 用户过滤** 的方式：

- hnswlib 的 label 只支持一个整数，我们设计为：
  - `global_label = image_id`（假设 image_id 在全局唯一）。
  - 通过一个 Python 字典记录 `label → { image_id, user_id }` 的映射。
- 查询时：
  - hnswlib 先返回 topK×overfetch 的候选 label；
  - 在 Python 里按 `user_id` 过滤，只保留当前用户的图片；
  - 若过滤后数量不足，再适当提高 overfetch 或回退到 FTS。

> 如果后续用户量明显上来，可以再演进为「每用户一个小索引」，目前个人相册场景用「单索引 + 过滤」足够。

#### 3.2 构建与加载

- **初次构建**：
  - 启动时（`app.py` → `load_all_models` 之后），新增一个步骤：
    - 从 SQLite 读取所有 `image_embeddings`（或按批次分页读取）；
    - 创建 hnswlib 索引，调用 `add_items(vectors, labels)`；
    - 把映射表 `label_meta[label] = (image_id, user_id)` 存在内存里；
    - 同时将索引和映射表落盘（例如 `models/hnsw_index.bin` + `hnsw_meta.json`）。
- **后续启动**：
  - 若存在索引文件，优先 `index.load_index()` + 载入 meta，不必每次全量重建；
  - 若索引丢失或不一致，再走全量扫描重建。

#### 3.3 增量更新策略（简化版）

阶段 B 先做一个**简单但可靠**的版本：

- 图片首次生成 embedding 后：
  - Node 写入 `image_embeddings`；
  - 再通过一个轻量 HTTP 调用，通知 Python「有新的 image_id + 向量」；
  - Python 内存中的 hnswlib 调用 `add_items` 动态增加。
- 删除 / 回收站处理：
  - hnswlib 原生不擅长删除，可以先只做「软删除」：
    - SQLite 中有 `deleted_at` 字段；
    - 内存里对于 `deleted` 的图片打一个 `is_deleted` 标记；
    - 查询结果中若命中 `is_deleted` 的 label，则跳过，向下取下一名。

> 真正的大规模删除 / 结构变化时，可以触发「全量重建索引」任务，但你的个人项目短期很少遇到这种情况。

---

### 4. Node / Python 接口改造方案

#### 4.1 Python 新增高层 API（内部）

在 `services/text_embedding_service.py` 或新的 `services/vector_search_service.py` 中新增：

- `init_hnsw_index()`：启动时调用，负责加载 / 构建索引。
- `ann_search(user_id: int, query_vector: List[float], top_k: int) -> List[Dict]`：
  - 内部直接通过 hnswlib 索引返回 `[{ image_id, score }]`，不需要 `candidates` 参数。

#### 4.2 Python 新增 HTTP 接口（外部）

在 `routes/search_embedding.py` 中新增：

- `POST /ann_search_by_vector`：
  - 入参：`{ "user_id": number, "query_vector": [...], "top_k": 50 }`
  - 出参：`{ "results": [{ "image_id": number, "score": float }] }`

保留原来的 `/search_by_vector` 作为「暴力扫备选接口」，方便测试对比精度和性能。

#### 4.3 Node 调用方式调整

- 在 `pythonSearchClient.js` 中新增：
  - `annSearchByVector(userId, queryVector, topK)`：调用新的 `/ann_search_by_vector`。
- 在 `searchController.js` 的 `handleSearchImages` 中：
  - 有 query 时，调用 `encodeText` → `annSearchByVector(userId, queryVector, pageSize * 2)`；
  - 不再调用 `getImageEmbeddingsByUserId` + 传 candidates 列表；
  - 其它逻辑（RRF 合并 FTS + 向量结果、分页）保持不变。

---

### 5. 风险与注意事项

1. **内存占用**
   - hnswlib 索引会把所有图像向量常驻内存，内存占用大约为：  
     \[N × 1152 × 4 Bytes × 系数\]（系数 ~1.3–2.0 用于图结构）。
   - 对几万张图片级别在本机完全可控，但要注意未来增长。

2. **构建时间**
   - 首次构建索引时，可能需要几秒到十几秒（视 N 而定），建议：
     - 在服务启动早期完成；
     - 或者提供一个「后台构建」模式：先用暴力扫兜底，索引建好后自动切换。

3. **一致性**
   - 阶段 B 可以接受「最终一致」而非「强一致」：
     - 刚上传的图片，可能在 1～2 秒内还没进索引，只能被 FTS 命中；
     - 清理 / 删除后的一小段时间里，也可能仍然被索引召回，前端看到的是旧数据。

4. **调参复杂度**
   - hnswlib 的 `M`、`ef_construction`、`ef_search` 等参数会影响速度和精度；
   - 阶段 B 可以先采用推荐默认值（如 `M=16`, `ef_construction=200`, `ef_search=64`），后续再通过日志和体验调整。

---

### 6. 阶段 B 实施步骤建议

1. **准备阶段**
   - 在 `requirements.txt` 中加入 `hnswlib`（或 `pip install hnswlib` 测试）；
   - 写一个独立的小脚本，用 1000 条左右的 embeddings 做 hnswlib 实验，确认可行。

2. **后端（Python）实现**
   - 在 `python-ai-service` 新增 hnsw 索引管理模块：
     - 支持从 SQLite 全量构建索引；
     - 支持增量添加新向量；
     - 支持按 user_id 过滤的 `ann_search`。
   - 在 `routes/search_embedding.py` 新增 `/ann_search_by_vector`。

3. **后端（Node）接入**
   - 在 `pythonSearchClient.js` 中新增 `annSearchByVector`；
   - 在 `searchController.js` 中切换向量搜索为 hnsw ANN 接口（保留老逻辑做 feature flag 或备用）。

4. **验证与对比**
   - 用同一批「query + 图片集」对比：
     - 暴力扫 `/search_by_vector` vs hnsw `/ann_search_by_vector` 的：
       - 返回结果是否相近（Top-1 / Top-10 命中率）；
       - 请求耗时、CPU 峰值、内存占用。

---

### 7. 与阶段 C 的关系

- 阶段 B（hnswlib 单机索引）本质上是一个「**大厂做法的缩小版**」：
  - 有离线/异步的 embedding；
  - 有常驻内存的 ANN 索引；
  - 在线请求只发 query 向量。
- 将来如果要升级到阶段 C（Milvus / OpenSearch / 外部向量数据库）：
  - Node 这一侧的调用模式基本不变（query 向量 → vector service → image_ids）；
  - 只是把 Python hnswlib 的实现替换成「真正的分布式向量服务」，迁移成本会相对可控。
