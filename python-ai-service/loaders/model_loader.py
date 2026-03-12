#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 模型统一加载器
统一管理所有视觉分析相关的 AI 模型

包含模型：
1. InsightFace - 人脸检测和特征提取
2. FairFace - 年龄和性别识别
3. EmotiEffLib - 表情识别
4. YOLOv11x - 人体检测（2025-10-27 新增，2025-11-01 升级）
5. SigLIP2 - 图像与文本多模态向量化
"""

import time
import json
from pathlib import Path

import insightface
import onnxruntime as ort
from emotiefflib.facial_analysis import EmotiEffLibRecognizerOnnx
from sentencepiece import SentencePieceProcessor

from logger import logger
from config import settings
from services.model_registry import get_model_config, get_fallback_model_id, resolve_local_path, resolve_model_id


# ========== 全局变量存储所有模型 ==========
face_app = None               # InsightFace 模型（人脸检测+特征提取）
fairface_session = None       # FairFace ONNX 模型（年龄性别识别，可选）
expression_model = None       # EmotiEffLib ONNX 模型（表情识别）
yolov11x_session = None       # YOLOv11x ONNX 模型（人体检测）
siglip_image_session = None   # SigLIP 图像编码 ONNX 会话（将图片转为 1152 维向量）
siglip_text_session = None    # SigLIP 文本编码 ONNX 会话（仅在图文任务需要）
siglip_tokenizer = None       # SigLIP 文本分词器（SentencePiece），配合 text encoder 使用
siglip_metadata = None        # SigLIP 预处理配置（尺寸/归一化/裁剪等）
aesthetic_head_session = None # 审美回归头 ONNX 会话（输入 SigLIP 向量 → 输出 0~100 分）
all_models_loaded = False     # 兼容旧字段：不再用于触发严格全量加载

# SigLIP2 多目录缓存：key 为模型目录绝对路径
_siglip_cache = {}

def load_all_models():
    """
    兼容旧接口：不再使用“严格模式”全量加载。

    当前行为：
    - 尽力加载各能力需要的模型（InsightFace / FairFace(可选) / EmotiEffLib / YOLOv11x / SigLIP2 standard / AestheticHead）
    - 任一加载失败不会阻止其它模型加载（与新版懒加载策略一致）
    
    加载目标（全部必须成功，否则阻止服务启动）：
    - 组 A（人物/表情）：InsightFace（人脸检测+特征）、FairFace（年龄性别）、EmotiEffLib（表情）
    - 组 B（人体）：YOLOv11x（人体检测）
    - 组 C（表征与审美）：SigLIP2 图像编码器（生成 1152 维向量）、Aesthetic Head 小头（向量 → 0~100 分）
    
    初始化顺序与约束：
    1) 优先加载人物相关基础模型（A 组），保障人物能力可用
    2) 再加载人体检测（B 组）
    3) 最后加载 SigLIP2 与 Aesthetic Head（C 组），这两者是清理/审美评分依赖
    
    执行提供者（providers）：
    - 统一走 settings.get_onnx_providers()，由配置决定 CPU/GPU
    - 个别模型（如 InsightFace）在 GPU 失败时会尝试回退到 CPU
    
    路径与文件完整性：
    - 所有模型路径统一使用 Path，并在加载前进行 exists() 检查
    - 缺失即抛 FileNotFoundError；任何模型加载异常都会中止启动
    
    资源提示（近似值，仅供容量规划）：
    - InsightFace/YOLOv11x 单个 ~200MB 量级；其余模型 10~100MB 不等
    - SigLIP2 与小头为 ONNX + .onnx.data 外置权重，需与主文件同目录
    """
    global face_app, fairface_session, expression_model, yolov11x_session, aesthetic_head_session, all_models_loaded
    
    start_time = time.time()
    logger.warning("⚠️ load_all_models() 已弃用：已切换为按需懒加载/预热策略，将尽力加载但不保证全量成功")
    
    # ========== 组A：人脸识别模型组 ==========
    logger.info("📦 加载人脸识别模型组...")
    
    # 获取 ONNX Runtime 执行提供者
    onnx_providers = settings.get_onnx_providers()
    logger.info(f"🔧 ONNX Runtime 执行提供者: {onnx_providers}")
    
    # 1. 加载 InsightFace（人脸检测+特征提取）
    try:
        face_app = _create_insightface_app(onnx_providers)
        logger.info("  ✅ InsightFace SCRFD 已加载")
    except Exception as e:
        logger.error("  ❌ InsightFace 加载失败: %s", e)
        face_app = None
    
    # 2. 加载 FairFace ONNX（年龄性别识别，可选）
    try:
        model_path = Path("models/face/fairface.onnx")
        fairface_session = _load_required_onnx(model_path, onnx_providers, "FairFace")
        logger.info("  ✅ FairFace ONNX 已加载")
    except Exception as e:
        logger.warning("  ⚠️ FairFace ONNX 加载失败（可选）: %s", e)
        fairface_session = None
    
    # 3. 加载 EmotiEffLib ONNX（表情识别）
    try:
        expression_model = EmotiEffLibRecognizerOnnx(model_name="enet_b0_8_best_afew")
        logger.info("  ✅ EmotiEffLib ONNX 已加载")
    except Exception as e:
        logger.error("  ❌ EmotiEffLib ONNX 加载失败: %s", e)
        expression_model = None
    
    logger.info("✅ 人脸识别模型组加载完成")
    
    # ========== 组B：人体检测模型组 ==========
    logger.info("📦 加载人体检测模型组...")
    
    # 4. 加载 YOLOv11x ONNX（人体检测）
    try:
        model_path = Path("models/object/yolo11x.onnx")
        yolov11x_session = _load_required_onnx(model_path, onnx_providers, "YOLOv11x")
        logger.info("  ✅ YOLOv11x ONNX 已加载")
    except Exception as e:
        logger.error("  ❌ YOLOv11x ONNX 加载失败: %s", e)
        yolov11x_session = None
    
    logger.info("✅ 人体检测模型组加载完成")

    # 5. 加载 SigLIP2 模块（图像向量，standard）
    logger.info("📦 初始化 SigLIP2 模型组件（standard）...")
    _ensure_siglip2_components(onnx_providers, raise_on_failure=False)
    logger.info("✅ SigLIP2 模块加载完成（若文件齐全）")

    # 6. 加载审美小头（SigLIP embedding -> 0~100）
    logger.info("📦 加载审美小头（SigLIP embedding → score）...")
    try:
        aesthetic_head_path = Path("models/aesthetic_head_musiq/siglip_aesthetic_head.onnx")
        aesthetic_head_session = _load_required_onnx(aesthetic_head_path, onnx_providers, "AestheticHead")
        logger.info("  ✅ Aesthetic Head ONNX 已加载")
    except Exception as e:
        logger.error("  ❌ Aesthetic Head ONNX 加载失败: %s", e)
        aesthetic_head_session = None

    # ========== 完成 ==========
    all_models_loaded = True
    elapsed = time.time() - start_time
    
    logger.info(f"🎉 load_all_models 完成（耗时 {elapsed:.2f}秒）")
    logger.info(f"   ✅ InsightFace (人脸检测+特征提取)")
    logger.info(f"   {'✅' if fairface_session is not None else '⚠️'} FairFace (年龄性别识别，可选)")
    logger.info(f"   {'✅' if expression_model is not None else '⚠️'} EmotiEffLib (表情识别)")
    logger.info(f"   {'✅' if yolov11x_session is not None else '⚠️'} YOLOv11x (人体检测)")
    logger.info(f"   {'✅' if siglip_image_session is not None else '⚠️'} SigLIP2 (图像向量化)")
    logger.info(f"   {'✅' if aesthetic_head_session is not None else '⚠️'} Aesthetic Head (审美回归头)")


def get_insightface_model():
    """获取 InsightFace 模型（人脸检测+特征提取，懒加载）。"""
    global face_app
    if face_app is not None:
        return face_app

    onnx_providers = settings.get_onnx_providers()
    try:
        face_app = _create_insightface_app(onnx_providers)
        logger.info("✅ InsightFace SCRFD 已懒加载完成")
    except Exception as e:  # pragma: no cover
        logger.error("❌ InsightFace 懒加载失败: %s", e)
        face_app = None
    return face_app


def get_fairface_session():
    """
    获取 FairFace ONNX 模型（年龄性别识别，可选）。

    设计要求：
    - FairFace 失败不应阻止主链路，仅影响年龄/性别输出。
    """
    global fairface_session
    if fairface_session is not None:
        return fairface_session

    onnx_providers = settings.get_onnx_providers()
    model_path = Path("models/face/fairface.onnx")
    try:
        fairface_session = _load_required_onnx(model_path, onnx_providers, "FairFace")
        logger.info("✅ FairFace ONNX 已懒加载完成")
    except Exception as e:  # pragma: no cover
        logger.warning("⚠️ FairFace 懒加载失败，将以无年龄/性别模式继续: %s", e)
        fairface_session = None
    return fairface_session


def get_expression_model():
    """获取 EmotiEffLib ONNX 模型（表情识别，懒加载）。"""
    global expression_model
    if expression_model is not None:
        return expression_model
    try:
        expression_model = EmotiEffLibRecognizerOnnx(model_name="enet_b0_8_best_afew")
        logger.info("✅ EmotiEffLib ONNX 已懒加载完成")
    except Exception as e:  # pragma: no cover
        logger.error("❌ EmotiEffLib 模型懒加载失败，将不返回表情结果: %s", e)
        expression_model = None
    return expression_model


def get_yolov11x_session():
    """获取 YOLOv11x ONNX 模型（人体检测，懒加载）。"""
    global yolov11x_session
    if yolov11x_session is not None:
        return yolov11x_session

    onnx_providers = settings.get_onnx_providers()
    model_path = Path("models/object/yolo11x.onnx")
    try:
        yolov11x_session = _load_required_onnx(model_path, onnx_providers, "YOLOv11x")
        logger.info("✅ YOLOv11x ONNX 已懒加载完成")
    except Exception as e:  # pragma: no cover
        logger.error("❌ YOLOv11x 懒加载失败，人体检测将不可用: %s", e)
        yolov11x_session = None
    return yolov11x_session


def all_face_models_loaded():
    """检查所有人脸模型是否已加载
    
    用途:
    - 健康检查接口调用
    - 监控服务状态
    
    返回值:
    - True: 所有人脸模型已加载并可用（InsightFace + FairFace + EmotiEffLib）
    - False: 模型未加载或加载失败
    """
    # 为兼容旧逻辑，保留该接口：
    # 判断核心人脸相关模型是否已成功懒加载。
    return bool(face_app)


def get_siglip2_components():
    """
    获取 SigLIP2 图像/文本编码器会话与分词器、元数据（standard 档）。

    说明：
    - 为兼容现有调用方，仍提供无 profile 版本，默认使用 standard SigLIP2 目录。
    - 懒加载：首次调用时才初始化 ONNX 会话与元数据。
    """
    global siglip_image_session, siglip_text_session, siglip_tokenizer, siglip_metadata

    if siglip_image_session is not None and siglip_text_session is not None and siglip_metadata is not None:
        return siglip_image_session, siglip_text_session, siglip_tokenizer, siglip_metadata

    providers = settings.get_onnx_providers()

    # 默认使用注册表中的 standard SigLIP2 配置；若配置缺失，则退回 models/siglip2/standard
    cfg = get_model_config("embedding.standard.siglip2.base")
    base_dir = resolve_local_path(cfg.local_path) if cfg else "models/siglip2/standard"

    image_sess, text_sess, tokenizer, metadata = get_siglip2_components_for_path(base_dir, providers=providers)
    siglip_image_session = image_sess
    siglip_text_session = text_sess
    siglip_tokenizer = tokenizer
    siglip_metadata = metadata
    return siglip_image_session, siglip_text_session, siglip_tokenizer, siglip_metadata


def get_siglip2_components_for_path(
    model_dir: str,
    *,
    providers=None,
    raise_on_failure: bool = False,
):
    """
    按模型目录加载 SigLIP2 组件（image/text encoder + tokenizer + metadata），并按目录缓存。

    Args:
        model_dir: SigLIP2 模型所在目录（如 models/siglip2/standard 或 enhanced）
        providers: ONNX Runtime providers；默认使用 settings.get_onnx_providers()
        raise_on_failure: 加载失败时是否抛异常
    """
    global _siglip_cache

    if providers is None:
        providers = settings.get_onnx_providers()

    base = Path(model_dir)
    key = str(base.resolve())
    if key in _siglip_cache:
        return _siglip_cache[key]

    image_path = base / "siglip2_image_encoder.onnx"
    text_path = base / "siglip2_text_encoder.onnx"
    metadata_path = base / "metadata.json"
    tokenizer_path = base / "tokenizer.model"

    required_files = [image_path, text_path, metadata_path, tokenizer_path]
    missing = [str(p) for p in required_files if not p.exists()]
    if missing:
        message = f"SigLIP2 模型文件缺失: {', '.join(missing)}"
        logger.error(message)
        if raise_on_failure:
            raise FileNotFoundError(message)
        _siglip_cache[key] = (None, None, None, None)
        return _siglip_cache[key]

    try:
        image_sess = _create_onnx_session(image_path, providers)
        text_sess = _create_onnx_session(text_path, providers)
        with metadata_path.open("r", encoding="utf-8") as meta_file:
            metadata = json.load(meta_file)

        tokenizer = None
        try:
            sp = SentencePieceProcessor()
            sp.Load(str(tokenizer_path))
            tokenizer = sp
            logger.info(
                "✅ SigLIP2 组件已加载",
                extra={"model_dir": str(base)},
            )
        except Exception as exc:
            tokenizer = None
            logger.error(
                "❌ SigLIP2 分词器加载失败",
                extra={"model_dir": str(base), "error": str(exc)},
            )
            if raise_on_failure:
                raise RuntimeError(f"SigLIP2 分词器加载失败: {exc}") from exc

        _siglip_cache[key] = (image_sess, text_sess, tokenizer, metadata)
        return _siglip_cache[key]
    except Exception as exc:  # pragma: no cover
        logger.error(
            "❌ 加载 SigLIP2 组件失败",
            extra={"model_dir": str(base), "error": str(exc)},
        )
        if raise_on_failure:
            raise RuntimeError(f"SigLIP2 组件加载失败: {exc}") from exc
        _siglip_cache[key] = (None, None, None, None)
        return _siglip_cache[key]


def get_aesthetic_head_session():
    """
    获取审美小头 ONNX 会话。

    - 懒加载：首次调用时按需加载；
    - 失败时抛出异常由上层捕获或返回 None。
    """
    global aesthetic_head_session
    if aesthetic_head_session is not None:
        return aesthetic_head_session

    providers = settings.get_onnx_providers()
    aesthetic_head_path = Path("models/aesthetic_head_musiq/siglip_aesthetic_head.onnx")
    try:
        aesthetic_head_session = _load_required_onnx(aesthetic_head_path, providers, "AestheticHead")
        logger.info("✅ Aesthetic Head ONNX 已懒加载完成")
    except Exception as e:  # pragma: no cover
        logger.error("❌ Aesthetic Head 懒加载失败: %s", e)
        aesthetic_head_session = None
    return aesthetic_head_session


def _ensure_siglip2_components(providers, *, raise_on_failure: bool = False):
    """
    兼容旧接口：仍从默认目录加载 SigLIP2（不区分 profile）。
    新代码应优先使用 get_siglip2_components_for_path 或在上层通过模型注册表选择目录。
    """
    global siglip_image_session, siglip_text_session, siglip_tokenizer, siglip_metadata

    image_sess, text_sess, tokenizer, metadata = get_siglip2_components_for_path(
        "models/siglip2/standard",
        providers=providers,
        raise_on_failure=raise_on_failure,
    )
    siglip_image_session = image_sess
    siglip_text_session = text_sess
    siglip_tokenizer = tokenizer
    siglip_metadata = metadata


def _create_onnx_session(model_path: Path, providers):
    """创建 ONNX 会话；GPU 失败自动回退到 CPU。"""
    try:
        return ort.InferenceSession(str(model_path), providers=providers)
    except Exception as e:
        # 若包含 CUDA 提供者，回退 CPU 再试
        provider_names = [p if isinstance(p, str) else getattr(p, 'name', str(p)) for p in providers]
        if any('CUDAExecutionProvider' in str(n) for n in provider_names):
            logger.warning(f"  ⚠️ {model_path.name} GPU 加载失败，回退 CPU: {e}")
            return ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
        raise


def _load_required_onnx(model_path: Path, providers, model_name: str):
    """统一的存在性校验 + 会话创建封装。
    
    - 校验文件存在，不存在直接抛 FileNotFoundError
    - 使用 _create_onnx_session 创建会话（带 GPU→CPU 回退）
    """
    if not model_path.exists():
        raise FileNotFoundError(f"{model_name} 模型文件缺失: {model_path}")
    return _create_onnx_session(model_path, providers)


def _create_insightface_app(providers):
    """创建 InsightFace 会话，GPU 失败自动回退 CPU。"""
    ctx_id = 0 if settings.USE_GPU else -1
    try:
        app = insightface.app.FaceAnalysis(providers=providers)
        app.prepare(ctx_id=ctx_id, det_size=settings.FACE_DET_SIZE)
        return app
    except Exception as e:
        if ctx_id != -1:
            logger.warning(f"  ⚠️ InsightFace GPU 加载失败，回退 CPU: {e}")
            app = insightface.app.FaceAnalysis(providers=['CPUExecutionProvider'])
            app.prepare(ctx_id=-1, det_size=settings.FACE_DET_SIZE)
            return app
        raise
