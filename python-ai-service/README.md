# Python AI Service

AI 图片分析服务，使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 进行高精度图片分析。  
功能：人物分析（人脸+人体检测）、人脸聚类、OCR、智能清理、**搜索向量化**（文本编码与向量相似度）。

---

## 环境要求

- Python 3.10+
- 虚拟环境（推荐使用项目目录下的 `venv`）

---

## 安装

```bash
# 进入服务目录
cd python-ai-service

# 创建虚拟环境（若尚未创建）
python3 -m venv venv

# 激活虚拟环境
source venv/bin/activate   # macOS/Linux
# Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

---

## 启动

在 `python-ai-service` 目录下执行：

```bash
python3 start.py
```

启动脚本会使用当前目录下的 `venv` 中的 Python 运行 `app.py`，服务启动后默认地址为 `http://0.0.0.0:5001`（可通过环境变量 `AI_SERVICE_HOST`、`AI_SERVICE_PORT` 修改）。

---

## 主要接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/analyze_person` | 人物分析（人脸+人体检测） |
| POST | `/analyze_cleanup` | 图片清理指标 |
| POST | `/cluster_faces` | 人脸聚类 |
| POST | `/encode_text` | 文本向量化（搜索用） |
| POST | `/search_by_vector` | 向量相似度搜索 |

---

## 环境变量（可选）

在项目根目录或 `python-ai-service` 下放置 `.env` 可覆盖默认配置，例如：

- `AI_SERVICE_HOST`：监听地址，默认 `0.0.0.0`
- `AI_SERVICE_PORT`：端口，默认 `5001`
- `USE_GPU`：是否使用 GPU，默认 `false`

更多配置见 `config.py`。
