# 人物检测完整落地方案

## 📊 核心问题

**当前状态**：

- 只有 InsightFace 人脸检测
- ❌ 无法检测背对相机的人
- ❌ 无法检测远景中的小人
- ❌ 无法检测人脸被遮挡的场景

**目标**：

- ✅ 检测所有人物（包括背面、远景、遮挡）
- ✅ 保持性能（不能太慢）
- ✅ 易于维护

---

## 🎯 三层检测方案详解

### 架构总览

```
输入图片
    ↓
┌─────────────────────────────────────────┐
│ 第1层：YOLOv10 人体检测（主干，必须）    │  ← 覆盖 85-95% 场景
│ 检测所有人物（正面、背面、远景）         │     推理时间：50-100ms
│ 输出：person 框 + 置信度                 │     必须实现 ⭐⭐⭐⭐⭐
└─────────────────────────────────────────┘
    ↓ 如果 confidence < 0.35（低分）
┌─────────────────────────────────────────┐
│ 第2层：RTMPose 姿态验证（辅助，可选）    │  ← 提升 5-8% 召回率
│ 验证低分框是否真的有人                   │     推理时间：+50-100ms
│ 输出：关键点 + 质量评分                  │     按需实现 ⭐⭐⭐⭐
└─────────────────────────────────────────┘
    ↓ 如果关键点质量差
┌─────────────────────────────────────────┐
│ 第3层：人体分割（辅助，可选）            │  ← 提升 2-5% 召回率
│ 分割人体轮廓，计算面积                   │     推理时间：+200-2000ms
│ 输出：mask + 面积占比                    │     不推荐 ⭐⭐
└─────────────────────────────────────────┘
```

---

## 📦 对应的 Python 库

| 层级      | 模型库        | 安装                                 | 用途                 |
| --------- | ------------- | ------------------------------------ | -------------------- |
| **第1层** | `ultralytics` | `pip install ultralytics`            | YOLOv10 人体检测     |
| **第2层** | `mmpose`      | `pip install mmpose mmcv`            | RTMPose 姿态估计     |
| **第3层** | `paddleseg`   | `pip install paddlepaddle paddleseg` | PP-HumanSeg 人体分割 |

**重要**：这**不是**三个库必须同时安装！

- ✅ **必须**：`ultralytics`（第1层）
- ⚠️ **可选**：`mmpose`（第2层，按需添加）
- ❌ **不推荐**：`paddleseg`（第3层，性价比低）

---

## 🚀 推荐的落地路径

### 阶段 1：最小可行方案（4-6 小时）⭐⭐⭐⭐⭐

**只实现第1层：YOLOv10 人体检测**

#### 1.1 安装依赖

```bash
cd python-ai-service
source venv/bin/activate
pip install ultralytics
```

#### 1.2 修改代码（已完成）

- ✅ `services/person_detector.py` - 人体检测器
- ✅ `loaders/face_loader.py` - 加载 YOLO 模型
- ✅ `services/face_service.py` - 整合人体检测

#### 1.3 数据库升级

```sql
-- 添加 person_count 字段
ALTER TABLE images ADD COLUMN person_count INTEGER DEFAULT 0;

-- 添加索引（用于筛选）
CREATE INDEX IF NOT EXISTS idx_images_person_count
ON images(user_id, person_count);
```

#### 1.4 Node.js 端适配

```javascript
// src/workers/searchIndexIngestor.js
const { faceCount, personCount, ...rest } = faceResult;

await updateImageSearchMetadata({
  imageId,
  faceCount,
  personCount, // 新增字段
  ...rest,
});
```

#### 1.5 测试验证

```bash
# 测试背面照片
curl -X POST http://localhost:5001/analyze_face \
  -F "image=@test-images/back-view.jpg"

# 预期返回
{
  "face_count": 0,      # 背面无脸
  "person_count": 2,    # 检测到 2 个人
  "faces": []
}
```

**效果**：

- ✅ 覆盖 85-95% 场景
- ✅ 背面、远景都能检测
- ✅ 性能影响小（+50-100ms）

---

### 阶段 2：姿态验证增强（1-2 天）⭐⭐⭐⭐

**何时实施**：YOLOv10 上线 1-2 周后，发现漏检率 > 5%

#### 2.1 安装依赖

```bash
pip install mmpose mmcv openmim
mim install mmengine mmdet
```

#### 2.2 实现逻辑

```python
# 只对低分检测框（0.20-0.35）进行验证
def detect_with_pose_verification(image):
    # 主干检测
    yolo_result = yolo.detect(image)

    confirmed_persons = []

    for person in yolo_result['persons']:
        if person['confidence'] >= 0.35:
            # 高置信度，直接通过
            confirmed_persons.append(person)
        elif person['confidence'] >= 0.20:
            # 低置信度，用姿态验证
            pose = rtmpose.detect(image, person['bbox'])
            if is_valid_pose(pose):
                confirmed_persons.append(person)

    return len(confirmed_persons)
```

**收益**：+5-8% 召回率

---

### 阶段 3：人体分割兜底（2-3 天）⭐⭐

**不推荐**，原因：

- ❌ 性能开销大（+200-2000ms）
- ❌ 收益小（+2-5%）
- ❌ 维护复杂

---

## 📊 方案对比

| 方案                       | 开发时间 | 性能影响    | 召回率提升 | 推荐度     |
| -------------------------- | -------- | ----------- | ---------- | ---------- |
| **仅 InsightFace**（当前） | 已完成   | 0ms         | 基准       | -          |
| **+ YOLOv10**（阶段1）     | 4-6小时  | +50-100ms   | +15-20%    | ⭐⭐⭐⭐⭐ |
| **+ RTMPose**（阶段2）     | 1-2天    | +100-200ms  | +5-8%      | ⭐⭐⭐⭐   |
| **+ 分割**（阶段3）        | 2-3天    | +500-2000ms | +2-5%      | ⭐⭐       |

---

## 💻 完整实施步骤（阶段 1）

### 步骤 1：安装 ultralytics

```bash
cd /path/to/python-ai-service
source venv/bin/activate
pip install ultralytics
```

### 步骤 2：代码已准备好 ✅

- ✅ `services/person_detector.py` - 已创建
- ✅ `loaders/face_loader.py` - 已更新
- ✅ `services/face_service.py` - 已整合

### 步骤 3：数据库升级

```bash
cd /path/to/xiaoxiao-project-service

sqlite3 database.db << 'EOF'
-- 添加 person_count 字段
ALTER TABLE images ADD COLUMN person_count INTEGER DEFAULT 0;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_images_person_count
ON images(user_id, person_count);

-- 验证
SELECT COUNT(*) FROM images WHERE person_count IS NOT NULL;
EOF
```

### 步骤 4：Node.js 端适配

#### 4.1 更新 imageModel.js

```javascript
// src/models/imageModel.js
function updateImageSearchMetadata({
  imageId,
  faceCount,
  personCount,  // 新增
  // ... 其他字段
}) {
  const updateSQL = `
    UPDATE images SET
      face_count = COALESCE(?, face_count),
      person_count = COALESCE(?, person_count),  -- 新增
      ...
    WHERE id = ?
  `;

  stmt.run(faceCount, personCount, ...);
}
```

#### 4.2 更新 searchIndexIngestor.js

```javascript
// src/workers/searchIndexIngestor.js
const { faceCount, personCount, ...rest } = faceResult;

await updateImageSearchMetadata({
  imageId,
  faceCount,
  personCount, // 新增
  ...rest,
});
```

#### 4.3 更新前端筛选（可选）

```javascript
// 前端可以按"有人物"筛选
filters: {
  hasPerson: personCount > 0 || faceCount > 0;
}
```

### 步骤 5：测试验证

```bash
# 重启 Python AI 服务
cd python-ai-service
pkill -f "python.*start.py"
python3 start.py

# 测试不同场景
curl -X POST http://localhost:5001/analyze_face -F "image=@test/front-face.jpg"
# → face_count=2, person_count=2

curl -X POST http://localhost:5001/analyze_face -F "image=@test/back-view.jpg"
# → face_count=0, person_count=3  ← 关键：检测到背面人物

curl -X POST http://localhost:5001/analyze_face -F "image=@test/far-landscape.jpg"
# → face_count=0, person_count=5  ← 关键：检测到远景小人
```

---

## 🎯 数据流示意

### 当前方案（只有人脸）

```
输入图片
    ↓
InsightFace
    ↓
face_count = 2（只检测到正面的人）
```

**问题**：背面的 3 个人漏检

---

### 新方案（人脸 + 人体）

```
输入图片
    ├→ InsightFace → face_count = 2
    └→ YOLOv10 → person_count = 5

综合判断：max(2, 5) = 5 ✅
```

**结果**：所有人都被检测到

---

## 📈 预期效果

### 检测能力对比

| 场景     | 当前（仅人脸）  | 新方案（+人体） | 提升      |
| -------- | --------------- | --------------- | --------- |
| 正面合照 | ✅ 5人          | ✅ 5人          | 持平      |
| 侧面照   | ✅ 3人          | ✅ 3人          | 持平      |
| 背面照   | ❌ 0人          | ✅ 4人          | **+100%** |
| 远景照   | ⚠️ 2人（漏3人） | ✅ 5人          | **+150%** |
| 遮挡照   | ⚠️ 1人（漏2人） | ✅ 3人          | **+200%** |

**总体召回率提升**：~15-20%

---

## ⚠️ 注意事项

### 1. 性能考虑

```python
# 推理时间对比
InsightFace only: ~200ms
InsightFace + YOLOv10: ~250-300ms  (+25-50%)
```

**建议**：

- ✅ 批量处理时可接受
- ⚠️ 如果是实时上传，考虑异步处理

### 2. 准确度权衡

```python
# YOLOv10 可能的误检
• 人形雕像、人形广告牌 → 可能误检为人
• 特别模糊的远景 → 可能漏检

# 解决方案
confidence >= 0.35  # 使用较高阈值，减少误检
```

### 3. 存储成本

```
新增字段：person_count (4 bytes/图)
1000 张图片 ≈ 4KB
完全可忽略
```

---

## 🔧 是否必须实现三层？

### ❌ 不必须！推荐分阶段：

**第1阶段（必须）**：

- ✅ YOLOv10（第1层）
- 时间：4-6 小时
- 覆盖率：85-95%

**第2阶段（按需）**：

- ⚠️ 观察 1-2 周，漏检率是否 > 5%
- 如果是 → 添加 RTMPose（第2层）
- 如果否 → 不需要

**第3阶段（不推荐）**：

- ❌ 人体分割性价比太低
- 除非特殊需求，否则不建议

---

## 📝 实施建议

### 最小可行方案（推荐）

```
只实现：YOLOv10 人体检测

优点：
✅ 简单（4-6 小时）
✅ 覆盖 85-95% 场景
✅ 维护成本低
✅ 性能影响小

效果：
• 背面照：0人 → 检测到
• 远景照：漏检 → 检测到
• 遮挡照：部分漏检 → 大幅改善
```

### 完整方案（如需极致召回）

```
实现：YOLOv10 + RTMPose

优点：
✅ 召回率 95%+
✅ 几乎不漏检

缺点：
❌ 开发时间长（3-4 天）
❌ 性能影响大（+150-200ms）
❌ 维护复杂
```

---

## 🎯 我的建议

**先实现第1层（YOLOv10），观察效果**

**原因**：

1. 80-20 原则：20% 的工作覆盖 80% 的场景
2. 第1层已经能解决大部分问题
3. 第2、3层收益递减，但复杂度递增

**实施步骤**：

1. ✅ 安装 `ultralytics`
2. ✅ 代码已准备好（本次修改）
3. ⬜ 数据库添加 `person_count` 字段
4. ⬜ Node.js 端适配
5. ⬜ 测试验证
6. ⬜ 观察 1-2 周，决定是否需要第2层

---

## 📊 性能基准测试

```python
# 预期性能（基于 YOLOv10s + CPU）
单人照：~50ms
双人照：~60ms
5人合照：~80ms
10人远景：~100ms

# 内存占用
YOLOv10s 模型：~12MB
运行时内存峰值：+50-100MB
```

---

## 🔍 常见问题

### Q1：必须三层全开吗？

**A**：❌ 不必须！只需第1层（YOLOv10）就能覆盖 85-95% 场景。

### Q2：会不会很慢？

**A**：+50-100ms，对于相册应用完全可接受。

### Q3：准确度如何？

**A**：YOLOv10s mAP@50 约 53%，人物检测（person 类）准确度约 90%+。

### Q4：会误检吗？

**A**：可能误检人形雕像、广告牌，但概率很低（<2%）。可通过提高阈值（0.35→0.40）减少误检。

### Q5：第2、3层什么时候需要？

**A**：

- 第2层：漏检率 > 5% 时
- 第3层：基本不需要（除非极特殊需求）

---

## ✅ 当前状态

**已完成**：

- ✅ PersonDetector 类
- ✅ 模型加载器更新
- ✅ face_service 整合
- ✅ 返回 person_count 字段

**待完成**：

- ⬜ 安装 ultralytics
- ⬜ 数据库升级（添加 person_count 字段）
- ⬜ Node.js 端适配
- ⬜ 测试验证

**预计剩余时间**：2-3 小时
