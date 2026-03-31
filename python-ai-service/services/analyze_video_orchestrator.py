#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POST /analyze_video 编排：均匀抽帧 → 每帧 run_analyze_image → 跨帧聚合为与单图一致的四模块结构。
不将 video 统计块入库；结束时打结构化日志 analyze_video_summary。
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from config import settings
from constants.error_codes import AI_SERVICE_ERROR, IMAGE_DECODE_FAILED
from logger import logger
from services.analyze_image_orchestrator import run_analyze_image
from services.model_manager import get_model_manager
from services.module_result import MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result
from services.video_merge_text import merge_frame_descriptions_to_video_summary
from utils.analyze_video_path import resolve_video_path_for_analyze
from utils.device import normalize_device


def _uniform_frame_indices(frame_count: int, max_frames: int) -> List[int]:
    """在 [0, frame_count-1] 上近似均匀取 K 个帧索引。"""
    if frame_count <= 0 or max_frames <= 0:
        return []
    k = min(max_frames, frame_count)
    out: List[int] = []
    for i in range(k):
        idx = int((i + 0.5) * frame_count / k)
        idx = max(0, min(frame_count - 1, idx))
        out.append(idx)
    # 去重保序
    seen = set()
    uniq: List[int] = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def _coerce_non_negative_int(value: Any) -> int:
    if value is None:
        return 0
    try:
        x = int(round(float(value)))
        return x if x >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _aggregate_tags_from_frames(tag_lists: List[List[str]], *, top_n: int = 24) -> List[str]:
    c: Counter[str] = Counter()
    for arr in tag_lists:
        if not isinstance(arr, list):
            continue
        for t in arr:
            s = str(t or "").strip()
            if s:
                c[s] += 1
    return [k for k, _ in c.most_common(top_n)]


def _merge_ocr_texts(ocr_list: List[str]) -> str:
    parts: List[str] = []
    seen = set()
    for o in ocr_list:
        s = str(o or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        parts.append(s)
    return " ".join(parts)


def _cosine_similarity(a: List[float], b: List[float]) -> float:
    try:
        va = np.asarray(a, dtype=np.float32)
        vb = np.asarray(b, dtype=np.float32)
        if va.size == 0 or vb.size == 0 or va.size != vb.size:
            return -1.0
        na = float(np.linalg.norm(va))
        nb = float(np.linalg.norm(vb))
        if na <= 1e-12 or nb <= 1e-12:
            return -1.0
        return float(np.dot(va, vb) / (na * nb))
    except Exception:
        return -1.0


def _dedupe_video_faces(faces: List[Dict[str, Any]], *, similarity_threshold: float, max_faces: int) -> List[Dict[str, Any]]:
    """
    视频内轻量去重：按 embedding 余弦相似度合并近重复人脸，保留质量分更高者。
    输出按质量分降序截断到 max_faces。
    """
    uniq: List[Dict[str, Any]] = []
    for face in faces:
        emb = face.get("embedding")
        if not isinstance(emb, list) or len(emb) == 0:
            continue
        quality = float(face.get("quality_score") or 0.0)
        matched_idx = -1
        best_sim = -1.0
        for i, u in enumerate(uniq):
            sim = _cosine_similarity(emb, u.get("embedding") or [])
            if sim > best_sim:
                best_sim = sim
                matched_idx = i
        if matched_idx >= 0 and best_sim >= similarity_threshold:
            prev_q = float(uniq[matched_idx].get("quality_score") or 0.0)
            if quality > prev_q:
                uniq[matched_idx] = face
        else:
            uniq.append(face)
    uniq.sort(key=lambda x: float(x.get("quality_score") or 0.0), reverse=True)
    if max_faces > 0:
        return uniq[:max_faces]
    return uniq


def run_analyze_video(
    *,
    video_path: str,
    device: str,
    image_id: Optional[str] = None,
) -> Dict[str, Any]:
    """返回结构：image_id, duration_ms, data.{person,caption}。"""
    resolved_dev, dev_err = normalize_device(device)
    if dev_err:
        return _fail_all_modules(image_id, str(dev_err))

    max_bytes = int(getattr(settings, "ANALYZE_VIDEO_MAX_FILE_BYTES", 5 * 1024 * 1024 * 1024))
    real_path, path_err = resolve_video_path_for_analyze(video_path, max_bytes=max_bytes)
    if path_err or not real_path:
        return _fail_all_modules(image_id, path_err or "invalid path")

    max_frames = int(getattr(settings, "VIDEO_MAX_FRAMES", 10))
    started_total = time.perf_counter()

    cap = cv2.VideoCapture(real_path)
    if not cap.isOpened():
        return _fail_all_modules(image_id, "无法打开视频文件")

    try:
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        duration_sec = (frame_count / fps) if fps > 1e-6 else 0.0

        indices = _uniform_frame_indices(frame_count, max_frames)
        if not indices:
            return _fail_all_modules(image_id, "无法读取视频帧数")

        manager = get_model_manager()

        per_frame: List[Dict[str, Any]] = []
        sample_ts_ms: List[float] = []

        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame_bgr = cap.read()
            if not ret or frame_bgr is None:
                logger.warning("analyze_video: skip empty frame", details={"index": idx})
                continue
            t_ms = (idx / fps * 1000.0) if fps > 1e-6 else 0.0
            sample_ts_ms.append(t_ms)
            t0 = time.perf_counter()
            one = run_analyze_image(
                frame_bgr,
                device=resolved_dev,
                manager=manager,
                image_id=None,
                module_names=["person", "caption"],
            )
            one["_frame_index"] = idx
            one["_frame_analyze_ms"] = round((time.perf_counter() - t0) * 1000)
            # 日志中打印每一帧的 caption 结果，便于调试
            try:
                cap_mod = (one.get("data") or {}).get("caption") or {}
                cap_status = cap_mod.get("status")
                cap_data = cap_mod.get("data") or {}
                if cap_status == MODULE_STATUS_SUCCESS:
                    logger.info(
                        "analyze_video_frame_caption",
                        details={
                            "frame_index": idx,
                            "ts_ms": round(t_ms, 1),
                            "status": cap_status,
                            "description": cap_data.get("description"),
                        },
                    )
                else:
                    logger.info(
                        "analyze_video_frame_caption",
                        details={
                            "frame_index": idx,
                            "ts_ms": round(t_ms, 1),
                            "status": cap_status or "none",
                        },
                    )
            except Exception:
                pass
            per_frame.append(one)

        if not per_frame:
            return _fail_all_modules(image_id, "未能解码任何采样帧")

        agg = _aggregate_per_frame_results(per_frame)
        total_ms = round((time.perf_counter() - started_total) * 1000)

        log_payload = {
            "event": "analyze_video_summary",
            "image_id": image_id,
            "video_path": real_path,
            "duration_sec": round(duration_sec, 3),
            "frame_count_reported": frame_count,
            "fps": round(fps, 3) if fps else None,
            "sampled_frames": len(per_frame),
            "sample_indices": [p.get("_frame_index") for p in per_frame],
            "sample_ts_ms": [round(x, 1) for x in sample_ts_ms[:20]],
            "total_duration_ms": total_ms,
            "module_status": {k: v.get("status") for k, v in (agg.get("data") or {}).items()},
        }
        logger.info("analyze_video_summary", details=log_payload)

        out = {
            "image_id": image_id,
            "duration_ms": total_ms,
            "data": agg["data"],
        }
        return out
    finally:
        cap.release()


def _aggregate_per_frame_results(per_frame: List[Dict[str, Any]]) -> Dict[str, Any]:
    """将多帧 run_analyze_image 结果聚合为视频关注的模块（person/caption）。"""
    captions_ok: List[Dict[str, Any]] = []
    video_faces_raw: List[Dict[str, Any]] = []

    best_person_frame_i = None
    best_face = -1

    for i, fr in enumerate(per_frame):
        data = fr.get("data") or {}
        cap_m = data.get("caption") or {}
        if cap_m.get("status") == MODULE_STATUS_SUCCESS and isinstance(cap_m.get("data"), dict):
            captions_ok.append(cap_m["data"])

        per = data.get("person") or {}
        if per.get("status") == MODULE_STATUS_SUCCESS and isinstance(per.get("data"), dict):
            pd = per["data"]
            fc = _coerce_non_negative_int(pd.get("face_count"))
            if best_person_frame_i is None or fc > best_face:
                best_face = fc
                best_person_frame_i = i
            faces = pd.get("faces")
            if isinstance(faces, list):
                for f in faces:
                    if not isinstance(f, dict):
                        continue
                    if not bool(f.get("is_high_quality")):
                        continue
                    emb = f.get("embedding")
                    if not isinstance(emb, list) or len(emb) == 0:
                        continue
                    video_faces_raw.append(
                        {
                            "face_index": f.get("face_index"),
                            "embedding": {"status": MODULE_STATUS_SUCCESS, "data": {"vector": emb}},
                            "age": f.get("age"),
                            "gender": f.get("gender"),
                            "expression": f.get("expression"),
                            "confidence": f.get("expression_confidence") or f.get("confidence"),
                            "quality_score": f.get("quality_score"),
                            "bbox": f.get("bbox") or [],
                            "pose": f.get("pose") or {},
                        }
                    )

    # --- person：取人脸数最多的那一帧（含 0 人脸时取首帧成功结果）---
    pdata = None
    if best_person_frame_i is not None:
        pdata = per_frame[best_person_frame_i].get("data", {}).get("person", {}).get("data")
    dedup_sim = float(getattr(settings, "VIDEO_PERSON_DEDUP_SIMILARITY", 0.55))
    max_video_faces = int(getattr(settings, "VIDEO_PERSON_MAX_FACES", 24))
    video_faces = _dedupe_video_faces(
        video_faces_raw,
        similarity_threshold=dedup_sim,
        max_faces=max_video_faces,
    )
    if isinstance(pdata, dict) and pdata:
        pdata_out = dict(pdata)
        # 视频 person：仅返回多帧去重后的 faces（与图片字段名一致），不再保留单帧 faces / video_faces
        pdata_out["faces"] = video_faces
        pdata_out["face_count"] = len(video_faces)
        p_mod = build_module_result(status=MODULE_STATUS_SUCCESS, data=pdata_out)
    else:
        p_mod = build_module_result(
            status=MODULE_STATUS_FAILED,
            error={"code": AI_SERVICE_ERROR, "message": "视频帧无有效 person"},
        )

    # --- caption：合并 ---
    if captions_ok:
        descriptions = [str(c.get("description") or "").strip() for c in captions_ok]
        descriptions = [d for d in descriptions if d]
        merged_desc = merge_frame_descriptions_to_video_summary(descriptions) if descriptions else ""

        kw_lists = [c.get("keywords") for c in captions_ok if isinstance(c.get("keywords"), list)]
        sub_lists = [c.get("subject_tags") for c in captions_ok if isinstance(c.get("subject_tags"), list)]
        act_lists = [c.get("action_tags") for c in captions_ok if isinstance(c.get("action_tags"), list)]
        sc_lists = [c.get("scene_tags") for c in captions_ok if isinstance(c.get("scene_tags"), list)]

        keywords = _aggregate_tags_from_frames([x for x in kw_lists if x])
        subject_tags = _aggregate_tags_from_frames([x for x in sub_lists if x])
        action_tags = _aggregate_tags_from_frames([x for x in act_lists if x])
        scene_tags = _aggregate_tags_from_frames([x for x in sc_lists if x])

        ocr_merged = _merge_ocr_texts([str(c.get("ocr") or "").strip() for c in captions_ok])

        fc_max = max((_coerce_non_negative_int(c.get("face_count")) for c in captions_ok), default=0)
        pc_max = max((_coerce_non_negative_int(c.get("person_count")) for c in captions_ok), default=0)

        cdata = {
            "description": merged_desc,
            "keywords": keywords,
            "subject_tags": subject_tags,
            "action_tags": action_tags,
            "scene_tags": scene_tags,
            "ocr": ocr_merged,
            "face_count": fc_max,
            "person_count": pc_max,
        }
        c_mod = build_module_result(status=MODULE_STATUS_SUCCESS, data=cdata)
    else:
        c_mod = build_module_result(
            status=MODULE_STATUS_FAILED,
            error={"code": AI_SERVICE_ERROR, "message": "视频帧无有效 caption"},
        )

    # 统一 duration_ms 占位（各模块细粒度在单帧已计）
    for name, mod in ("person", p_mod), ("caption", c_mod):
        mod["duration_ms"] = mod.get("duration_ms", 0)

    return {
        "data": {
            "person": p_mod,
            "caption": c_mod,
        }
    }


def _fail_all_modules(image_id: Optional[str], message: str) -> Dict[str, Any]:
    err = {"code": IMAGE_DECODE_FAILED, "message": message}
    one = {
        "status": MODULE_STATUS_FAILED,
        "duration_ms": 0,
        "error": err,
    }
    return {
        "image_id": image_id,
        "duration_ms": 0,
        "data": {
            "person": dict(one),
            "caption": dict(one),
        },
    }
