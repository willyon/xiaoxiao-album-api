# Python AI Service

AI 图片分析服务，使用 InsightFace + FairFace + EmotiEffLib + YOLOv11x 进行高精度图片分析。  
功能：人物分析（人脸+人体检测）、人脸聚类、OCR、智能清理、embedding 生成。

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

> **说明：为什么必须用虚拟环境？**  
> 在 macOS（尤其是通过 Homebrew 安装的 Python）中，系统 Python 环境是「受管环境」，直接执行  
> `python3 -m pip install -r requirements.txt` 往往会报 `externally-managed-environment` 错误。  
> 因此，请始终在本项目自带的 `venv` 中安装依赖，方式有两种：
>
> - **方式一（推荐）**：先 `source venv/bin/activate`，然后使用 `pip install -r requirements.txt`  
> - **方式二**：不激活虚拟环境，直接使用虚拟环境中的 Python：
>
>   ```bash
>   ./venv/bin/python -m pip install -r requirements.txt
>   ```
>
> 启动服务或运行脚本前，建议已激活 `venv`，这样使用 `python` / `pip` 时会自动走虚拟环境，避免和系统 Python 冲突。

---

## 启动

在 `python-ai-service` 目录下执行：

```bash
python3 start.py
```

启动脚本会使用当前目录下的 `venv` 中的 Python 运行 `app.py`，服务启动后默认地址为 `http://0.0.0.0:5001`（可通过环境变量 `AI_SERVICE_HOST`、`AI_SERVICE_PORT` 修改）。

---

## 模型资产准备（统一入口）

如果需要手动准备或重新导出模型资产（例如 SigLIP2 / YOLO），可以使用统一入口脚本：

在 `python-ai-service` 目录下执行：

```bash
# 导出 SigLIP2 标准版（推荐作为默认配置）
python3 scripts/prepare_model_assets.py --family siglip2 --profile standard

# 导出 SigLIP2 增强版（更大模型，如失败可回退到 standard）
python3 scripts/prepare_model_assets.py --family siglip2 --profile enhanced

# 导出 YOLO（默认使用 yolo11x，可通过 --variant 覆盖）
python3 scripts/prepare_model_assets.py --family yolo --variant yolo11x
```

说明：

- `--family`：模型家族，目前支持 `siglip2`、`yolo`（后续会逐步纳入更多 family）
- `--profile`：配置档位（如 `standard` / `enhanced`），主要用于 `siglip2`
- `--variant`：模型变体（如 `yolo11x` / `yolo11m`），主要用于 `yolo`
- 如未指定 `--output-dir`，会按约定落到 `models/managed/...` 目录下

后续如新增 family / plan，只需要扩展 `scripts/prepare_model_assets.py` 内部逻辑即可，调用入口保持不变。

---

## 主要接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/analyze_image` | 全量分析（caption / person / quality / embedding 统一入口） |
| POST | `/cluster_face_embeddings` | 人脸 embedding 聚类 |
| POST | `/crop_face_thumbnail` | 按 bbox 裁剪人脸缩略图 |

---

## 环境变量（可选）

在项目根目录或 `python-ai-service` 下放置 `.env` 可覆盖默认配置，例如：

- `AI_SERVICE_HOST`：监听地址，默认 `0.0.0.0`
- `AI_SERVICE_PORT`：端口，默认 `5001`
- `USE_GPU`：是否使用 GPU，默认 `false`

更多配置见 `config.py`（如 `NODE_ENV=development` 时会开启 `LOG_ANALYZE_IMAGE_RESULT`，打印 `/analyze_image` 响应预览日志）。
