# python-ai-service 代码与结构分析报告

## 1. 顶层目录结构（仅项目源码，不含 venv/logs/data）

```
python-ai-service/
├── app.py                    # FastAPI 入口
├── config.py                 # 配置（Settings + 环境变量）
├── logger.py                 # 自定义日志（依赖 log_codes）
├── log_codes.py              # 日志代码映射
├── start.py                  # 启动脚本（venv/python app.py）
├── requirements.txt
├── README.md
├── convert_fairface_to_onnx.py   # 根目录：FairFace 转 ONNX 一次性脚本
├── download_fairface_model.py   # 根目录：下载 FairFace 一次性脚本
├── debug_face_detection.py      # 根目录：人脸检测调试脚本
├── debug_person_detection.py    # 根目录：人体检测调试脚本
├── constants/
│   ├── __init__.py
│   ├── error_codes.py
│   └── scene_prompts.py
├── loaders/
│   ├── __init__.py
│   ├── model_loader.py
│   └── ocr_loader.py
├── models/
│   ├── __init__.py
│   ├── caption_model.py, cleanup_model.py, embedding_model.py
│   ├── object_model.py, ocr_engine.py, person_model.py, scene_model.py
│   └── siglip2/standard/version.txt
├── pipelines/
│   ├── __init__.py
│   ├── caption_pipeline.py, cleanup_pipeline.py, embedding_pipeline.py
│   ├── object_pipeline.py, ocr_pipeline.py, person_pipeline.py, scene_pipeline.py
├── routes/
│   ├── __init__.py
│   ├── caption.py, cleanup.py, face_cluster.py, health.py
│   ├── objects.py, ocr.py, person.py, scene.py, search_embedding.py
├── schemas/
│   ├── __init__.py
│   ├── caption_schema.py, error_schema.py, object_schema.py
│   ├── ocr_schema.py, scene_schema.py
├── services/
│   ├── __init__.py
│   ├── cleanup_analysis_service.py, cluster_service.py
│   ├── face_attribute_analyzer.py, face_detector.py, expression_analyzer.py
│   ├── model_manager.py, model_registry.py
│   ├── ocr_service.py          # ⚠️ 未被引用，冗余
│   ├── person_analysis_service.py, person_detector.py
│   ├── text_embedding_service.py, vector_search_service.py
├── utils/
│   ├── __init__.py
│   ├── device.py, errors.py, image_decode.py, images.py
│   ├── request_log_context.py, timeout.py
├── scripts/
│   ├── check_rtmw_model.py, download_rtmpose.py
│   ├── export_openclip_to_onnx.py, export_siglip2_to_onnx.py
│   ├── export_yolo11_to_onnx.py, export_yolo_to_onnx.py
│   ├── generate_aesthetic_dataset.py   # 依赖 SQLite `images` 表 / image_id
│   └── train_aesthetic_head.py
├── stubs/
│   ├── emotiefflib/__, facial_analysis
│   └── sentencepiece/__
├── data/                      # 数据集与预览（可忽略）
├── logs/                      # 日志文件
├── venv/
└── venv_py313_backup/         # ⚠️ 备份目录，README 为 deepface 无关内容
```

---

## 2. 冗余 / 弃用 / 未使用项

| 文件或符号 | 说明 |
|------------|------|
| **services/ocr_service.py** | 未被任何模块 import。OCR 实际走 `ocr_pipeline` → `model_manager.get_ocr_engine()` → `loaders.ocr_loader.get_ocr_model()` + `models/ocr_engine.PaddleOcrEngine`。此文件为旧版独立 OCR 服务，可删除。 |
| **log_codes.py: get_all_codes() / validate_code()** | 仅在本文件定义，项目内无引用，属死代码。保留 `get_code_description` 即可（logger 使用）。 |
| **scripts/generate_aesthetic_dataset.py** | 依赖 SQLite `images` 表与 `image_id`，属于一次性「从图库生成审美数据集」脚本，非运行时服务。若 DB 表已迁移或不再使用该脚本，可移至 `scripts/archive/` 或注明为历史脚本。 |
| **venv_py313_backup/** | 名称像 Python 3.13 虚拟环境备份，但内含 README 为 deepface 库内容，与项目无关。建议删除或移出仓库。 |

**关于「images」表与 image_id：**  
- 仅在 `scripts/generate_aesthetic_dataset.py` 中出现（读取 SQLite、生成 npz/CSV）。  
- 其余代码中的 `utils/images.py` 是「图片格式转 OpenCV」工具（如 `convert_to_opencv`），与 DB 表无关，命名易混淆但功能在用。

---

## 3. 一致性问题

### 3.1 错误响应体

- **统一约定（与 Node 一致）：** `{ "error_code": "XXX", "error_message": "..." }`，通过 `schemas/error_schema.ErrorBody` + `detail=ErrorBody(...).dict()` 返回。
- **caption / objects / ocr / scene / cleanup / person**：均使用 `ErrorBody`。
- **face_cluster.py**：`HTTPException(status_code=500, detail=str(e))` 或 `detail='人脸识别模型加载失败'`，返回的是纯字符串 `detail`，没有 `error_code` / `error_message`。
- **search_embedding.py**：`HTTPException(detail="文本不能为空")` 等，同样未使用 `ErrorBody`。

建议：`face_cluster`、`search_embedding` 的错误响应改为 `ErrorBody`，便于 Node 写入 `last_error` 及前端统一处理。

### 3.2 超时与业务异常处理

- **caption / ocr / objects / scene**：显式捕获 `AiTimeoutError`（504）、`AiServiceError`（500），并设置 `request_log_context` 的 error_code。
- **person.py**：未 import `AiTimeoutError` / `AiServiceError`，只捕获 `ValueError` 和通用 `Exception`。
- **cleanup**：未处理 `AiTimeoutError`，仅通用 `Exception`。

建议：person、cleanup 与其余分析接口对齐，对 `AiTimeoutError` / `AiServiceError` 做专门处理并打日志上下文。

### 3.3 图片解码入口

- **多数路由**：使用 `utils.image_decode.decode_image(image_bytes)`（含 EXIF 校正 + 回退到 `convert_to_opencv`）。
- **face_cluster.generate_face_thumbnail**、**person_analysis_service**、**cleanup_analysis_service**：直接使用 `utils.images.convert_to_opencv(image_bytes)`，不经过 `decode_image`，因此没有 EXIF 校正。

建议：需要「原图方向正确」的路径（如生成缩略图、清理分析）改为统一使用 `decode_image`，仅保留 `images.convert_to_opencv` 为底层实现或非 HTTP 的离线脚本使用。

### 3.4 配置与日志

- **配置**：统一从 `config.settings` 读取，环境变量集中在 `config.py`，无发现多处散落 env 读取。
- **日志**：已统一为 `logger.error("msg", details={...})`，不再使用 `logger.exception` 或 `logger.error("msg: %s", e)`。

### 3.5 路由风格

- 分析类接口均为 **async**，Form/File 使用方式一致；健康检查与能力查询为 GET。
- **cleanup** 有意不接收 `profile`/`device`，写死 `profile="standard"`, `device="cpu"`，与注释「保持原有请求参数兼容」一致，仅需在文档中说明即可。

---

## 4. 一次性/临时脚本建议

| 路径 | 建议 |
|------|------|
| **convert_fairface_to_onnx.py** | 移至 `scripts/`（如 `scripts/convert_fairface_to_onnx.py`），与其它 export 脚本放一起。 |
| **download_fairface_model.py** | 同上，移至 `scripts/`。 |
| **debug_face_detection.py** | 调试用，可移至 `scripts/debug/` 或保留在根目录并在 README 中说明用法。 |
| **debug_person_detection.py** | 同上。 |
| **scripts/generate_aesthetic_dataset.py** | 依赖旧 `images` 表，若仍会偶尔跑，保留并注明依赖；否则移至 `scripts/archive/`。 |
| **scripts/train_aesthetic_head.py** | 训练脚本，保留在 `scripts/` 即可。 |
| **venv_py313_backup/** | 建议从仓库中删除或移出，避免误导。 |

---

## 5. 建议清理与统一清单

**建议删除：**

- `services/ocr_service.py`（未被引用，逻辑已由 ocr_loader + ocr_engine 覆盖）
- `venv_py313_backup/` 整个目录（或至少移出仓库）

**建议移除的死代码：**

- `log_codes.py` 中的 `get_all_codes()`、`validate_code()`（若无计划被工具/脚本使用）

**建议统一：**

1. **错误体**：`routes/face_cluster.py`、`routes/search_embedding.py` 的 4xx/5xx 改为使用 `ErrorBody(error_code=..., error_message=...)`。
2. **异常处理**：`routes/person.py`、`routes/cleanup.py` 对 `AiTimeoutError`、`AiServiceError` 做显式捕获并设置 `request_log_context` 的 error_code。
3. **图片解码**：`face_cluster.generate_face_thumbnail`、以及 person_analysis_service / cleanup_analysis_service 中需要正确方向的图片解码，改为使用 `decode_image()`，减少重复逻辑并统一 EXIF 行为。
4. **脚本归位**：将根目录的 `convert_fairface_to_onnx.py`、`download_fairface_model.py` 移至 `scripts/`；调试脚本可集中到 `scripts/debug/` 或在 README 中注明。

**可选：**

- `config.py` 中 macOS CoreML 的注释块（248–252 行）可保留说明「暂用 CPU」原因，或缩成一行注释。
- `utils/images.py` 若希望避免与「images 表」混淆，可考虑重命名为 `utils/image_convert.py` 或 `utils/format_decode.py`（需全局替换 import）。

以上为对 `xiaoxiao-project-service/python-ai-service` 的目录结构、冗余代码、一致性与脚本整理的简要报告与建议。
