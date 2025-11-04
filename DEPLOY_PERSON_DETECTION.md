# YOLOv10 人体检测部署指南

## ✅ 已完成的工作

1. ✅ 代码已准备完毕
   - `python-ai-service/services/person_detector.py`
   - `python-ai-service/loaders/face_loader.py`
   - `python-ai-service/services/face_service.py`
   - `src/models/imageModel.js`
   - `src/workers/searchIndexIngestor.js`

2. ✅ 数据库已升级
   - 添加 `person_count` 字段
   - 创建索引 `idx_images_person_count`

3. ✅ requirements.txt 已更新
   - 添加 `ultralytics>=8.0.0`

---

## 🚀 剩余部署步骤

### 步骤 1：安装 ultralytics（必须）

由于项目 venv 有路径问题，需要手动安装：

```bash
cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service/python-ai-service

# 方案A：重新创建虚拟环境（推荐）
rm -rf venv
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 方案B：或者直接在现有 Python 环境安装
pip3 install ultralytics --break-system-packages --user

# 验证安装
python3 -c "from ultralytics import YOLO; print('✅ ultralytics 安装成功')"
```

---

### 步骤 2：重启 Python AI 服务

```bash
cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service/python-ai-service

# 停止旧服务
pkill -f "python.*start.py"

# 启动新服务
python3 start.py &

# 或使用 nohup 后台运行
nohup python3 start.py > logs/ai-service.log 2>&1 &

# 等待模型加载（约 3-5 秒）
sleep 5

# 验证服务健康
curl http://localhost:5001/health
```

**预期日志**：

```
🚀 开始加载所有AI模型...
  ✅ InsightFace SCRFD 已加载
  ✅ FairFace ONNX 已加载
  ✅ EmotiEffLib ONNX 已加载
  ✅ YOLOv10 人体检测器已加载      ← 新增
🎉 所有AI模型加载完成（耗时 3-4秒）
```

---

### 步骤 3：测试验证

#### 3.1 测试背面照片

```bash
cd /Volumes/Personal-Files/projects/xiaoxiao-album/xiaoxiao-project-service

# 找一张背面照片测试
curl -X POST http://localhost:5001/analyze_face \
  -F "image=@path/to/back-view.jpg" | python3 -m json.tool
```

**预期返回**：

```json
{
  "face_count": 0, // 背面无脸
  "person_count": 3, // ✅ 检测到 3 个人
  "faces": []
}
```

#### 3.2 测试正面照片

```bash
curl -X POST http://localhost:5001/analyze_face \
  -F "image=@localStorage/processed/original/1-20251019-220020-10.2942568.jpg" \
  | python3 -m json.tool
```

**预期返回**：

```json
{
  "face_count": 2,
  "person_count": 2,       // ✅ 人脸和人体一致
  "faces": [...]
}
```

#### 3.3 测试远景照片

```bash
curl -X POST http://localhost:5001/analyze_face \
  -F "image=@path/to/landscape-with-people.jpg" \
  | python3 -m json.tool
```

**预期返回**：

```json
{
  "face_count": 2,         // 只能看清 2 张脸
  "person_count": 5,       // ✅ 检测到 5 个人（包括远处的小人）
  "faces": [...]
}
```

---

### 步骤 4：重新上传图片测试

上传一些测试图片，观察数据库中的 `person_count` 字段是否正确填充。

```sql
-- 查看最新上传的图片
SELECT
  id,
  face_count,
  person_count,
  CASE
    WHEN person_count > face_count THEN '检测到背面/远景人物 ✅'
    WHEN person_count = face_count THEN '一致'
    ELSE '异常'
  END as status
FROM images
ORDER BY id DESC
LIMIT 10;
```

---

## 📊 预期效果

### 检测能力提升

| 场景类型 | 当前（仅人脸） | 新方案（+人体） | 提升      |
| -------- | -------------- | --------------- | --------- |
| 正面合照 | ✅ 检测到      | ✅ 检测到       | 持平      |
| 背面照   | ❌ 0人         | ✅ 检测到       | **+100%** |
| 远景照   | ⚠️ 部分漏检    | ✅ 全部检测     | **+50%**  |
| 侧面照   | ✅ 检测到      | ✅ 检测到       | 持平      |

### 性能影响

```
推理时间：200ms → 250-300ms (+25-50%)
模型加载时间：3秒 → 4秒 (+1秒)
内存占用：+50-100MB
```

---

## 🔧 故障排查

### 问题 1：YOLOv10 加载失败

**症状**：

```
⚠️ YOLOv10 加载失败（可选功能）: No module named 'ultralytics'
```

**解决**：

```bash
pip3 install ultralytics
# 或
source venv/bin/activate && pip install ultralytics
```

---

### 问题 2：person_count 始终为 0

**检查1**：YOLOv10 是否加载成功

```bash
curl http://localhost:5001/health
# 检查返回中是否有 person_detection: true
```

**检查2**：查看日志

```bash
tail -f python-ai-service/logs/$(date +%Y-%m-%d).log | grep "YOLOv10"
```

---

### 问题 3：检测太慢

**优化方案**：

```bash
# 使用更小的模型
# 修改 loaders/face_loader.py
person_detector = YOLO('yolov10n.pt')  # s → n (更快)

# 或降低图片分辨率
# 在 person_detector.py 中添加
results = self.model(image, imgsz=640)  # 限制输入尺寸
```

---

## 📝 后续优化（可选）

### 如果漏检率仍 > 5%

考虑添加第2层（RTMPose 姿态验证）：

```bash
pip install mmpose mmcv
```

实现逻辑参考 `PERSON_DETECTION_GUIDE.md` 的"阶段 2"。

---

## ✅ 部署检查清单

- [ ] ultralytics 已安装
- [ ] Python AI 服务已重启
- [ ] 日志显示"YOLOv10 人体检测器已加载"
- [ ] 测试背面照片，person_count > 0
- [ ] 测试正面照片，person_count ≈ face_count
- [ ] 数据库中 person_count 字段有值
- [ ] 性能在可接受范围（<300ms）

---

## 🎉 完成标志

当你看到：

```json
{
  "face_count": 0,
  "person_count": 3, // ← 关键：背面照也检测到了
  "faces": []
}
```

**恭喜！部署成功！** 🎊
