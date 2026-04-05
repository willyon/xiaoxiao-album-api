#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千问云 provider 公共工具。"""

from __future__ import annotations

import base64
import json
import re
import socket
from typing import Any, Dict, Iterable, List, Optional
from urllib import error, request

import cv2
import numpy as np

from logger import logger
from utils.errors import AiServiceError, AiTimeoutError

DEFAULT_QWEN_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_QWEN_MULTIMODAL_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"


def encode_image_to_data_url(image: Any, mime_type: str = "image/jpeg") -> str:
    """将 ndarray 图像编码为 data URL。"""
    if not isinstance(image, np.ndarray) or image.size == 0:
        raise AiServiceError("invalid image payload for qwen provider")
    ext = ".jpg" if mime_type == "image/jpeg" else ".png"
    ok, encoded = cv2.imencode(ext, image)
    if not ok or encoded is None:
        raise AiServiceError("failed to encode image for qwen provider")
    b64 = base64.b64encode(encoded.tobytes()).decode("utf-8")
    return f"data:{mime_type};base64,{b64}"


def resolve_endpoint(base_url: str, default_base_url: str, path_suffix: str) -> str:
    """将 base_url 解析为最终请求地址。"""
    suffix = "/" + path_suffix.strip("/")
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return default_base_url.rstrip("/") + suffix
    if base.endswith(suffix):
        return base
    return base + suffix


def post_json(url: str, payload: Dict[str, Any], api_key: str, timeout_seconds: float) -> Dict[str, Any]:
    """发送 JSON POST 请求并返回响应。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url=url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=timeout_seconds) as resp:
            raw = resp.read().decode("utf-8")
        # 云模型（OpenAI 兼容）原始 HTTP 响应体；不走 CustomLogger.details 以免被截断
        try:
            logger.logger.info("[qwen_openai_compatible] url=%s raw_response_body=%s", url, raw)
        except Exception:
            pass
    except error.HTTPError as exc:
        resp_body = exc.read().decode("utf-8", errors="replace")
        logger.warning(
            "qwen provider http error",
            details={"url": url, "status": exc.code, "body": resp_body[:1000]},
        )
        raise AiServiceError(_extract_error_message(resp_body) or f"qwen http error: {exc.code}")
    except error.URLError as exc:
        if isinstance(exc.reason, socket.timeout):
            raise AiTimeoutError()
        raise AiServiceError(f"qwen request failed: {exc.reason}")
    except socket.timeout:
        raise AiTimeoutError()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("qwen provider invalid json", details={"url": url, "body": raw[:1000]})
        raise AiServiceError(f"qwen response json decode failed: {exc}")


def extract_openai_finish_reason(response: Dict[str, Any]) -> Optional[str]:
    """OpenAI 兼容响应 choices[0].finish_reason，常见值：stop | length | content_filter。"""
    choices = response.get("choices") or []
    if not choices:
        return None
    fr = choices[0].get("finish_reason")
    if fr is None or fr == "":
        return None
    return str(fr).strip()


def extract_openai_message_text(response: Dict[str, Any]) -> str:
    """从 OpenAI 兼容响应中提取文本。"""
    choices = response.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    return _flatten_message_content(content)


def extract_qwen_output_content(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从 DashScope multimodal 响应中提取 message.content 列表。"""
    output = response.get("output") or {}
    choices = output.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    content = message.get("content") or []
    if isinstance(content, list):
        return [x for x in content if isinstance(x, dict)]
    return []


def extract_qwen_output_text(response: Dict[str, Any]) -> str:
    """从 DashScope multimodal 响应中提取纯文本内容。"""
    content = extract_qwen_output_content(response)
    return _flatten_message_content(content)


def parse_json_object_from_text(text: str) -> Optional[Dict[str, Any]]:
    """尽量从文本中提取 JSON 对象。"""
    raw = str(text or "").strip()
    if not raw:
        return None
    candidates = [raw]
    fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", raw, flags=re.S)
    candidates.extend(fenced)
    brace_match = re.search(r"\{.*\}", raw, flags=re.S)
    if brace_match:
        candidates.append(brace_match.group(0))
    for candidate in candidates:
        try:
            obj = json.loads(candidate)
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def normalize_keywords(raw_keywords: Any) -> List[str]:
    """将模型输出的关键词标准化为字符串数组。"""
    if isinstance(raw_keywords, str):
        parts = re.split(r"[,，、/\n\t]+", raw_keywords)
        return [p.strip() for p in parts if p and p.strip()]
    if isinstance(raw_keywords, Iterable):
        out: List[str] = []
        for item in raw_keywords:
            text = str(item or "").strip()
            if text:
                out.append(text)
        return out
    return []


def dedupe_keywords_against_tags(
    keywords: Any,
    subject_tags: Any,
    action_tags: Any,
    scene_tags: Any,
) -> List[str]:
    """
    从 keywords 中剔除与 subject/action/scene 任一标签完全相同的项（去重后顺序不变）。
    用于避免检索字段与结构化标签字面重复。
    """
    tag_set: set[str] = set()
    for group in (subject_tags, action_tags, scene_tags):
        if not isinstance(group, Iterable) or isinstance(group, (str, bytes)):
            continue
        for item in group:
            t = str(item or "").strip()
            if t:
                tag_set.add(t)
    raw_kw = normalize_keywords(keywords)
    out: List[str] = []
    seen_kw: set[str] = set()
    for k in raw_kw:
        if k in tag_set or k in seen_kw:
            continue
        seen_kw.add(k)
        out.append(k)
    return out


def polygon_to_bbox(location: Any) -> List[float]:
    """将四点坐标或 bbox 转成 [x1, y1, x2, y2]。"""
    if isinstance(location, list) and len(location) == 8:
        xs = [float(location[i]) for i in range(0, 8, 2)]
        ys = [float(location[i]) for i in range(1, 8, 2)]
        return [min(xs), min(ys), max(xs), max(ys)]
    if isinstance(location, list) and len(location) == 4:
        return [float(x) for x in location]
    return []


def rotate_rect_to_bbox(rotate_rect: Any) -> List[float]:
    """将 [cx, cy, width, height, angle] 简化为轴对齐 bbox。"""
    if not isinstance(rotate_rect, list) or len(rotate_rect) != 5:
        return []
    cx, cy, width, height, _angle = [float(x) for x in rotate_rect]
    half_w = width / 2.0
    half_h = height / 2.0
    return [cx - half_w, cy - half_h, cx + half_w, cy + half_h]


def _flatten_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                text = str(item.get("text") or item.get("content") or "").strip()
            else:
                text = ""
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    return ""


def _extract_error_message(resp_body: str) -> str:
    try:
        obj = json.loads(resp_body)
    except Exception:
        return resp_body.strip()[:300]
    for path in (
        ("error", "message"),
        ("message",),
        ("msg",),
        ("code",),
    ):
        current: Any = obj
        ok = True
        for key in path:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                ok = False
                break
        if ok and current:
            return str(current)
    return resp_body.strip()[:300]
