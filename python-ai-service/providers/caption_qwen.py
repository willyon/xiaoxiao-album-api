#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""千问 caption provider 实现。"""

from __future__ import annotations

from typing import Any, Dict

from constants.error_codes import AI_SERVICE_ERROR, AI_TIMEOUT
from logger import logger
from services.module_result import MODULE_STATUS_FAILED, MODULE_STATUS_SUCCESS, build_module_result
from config import settings
from providers.base import BaseCaptionProvider
from providers.qwen_common import (
    DEFAULT_QWEN_COMPATIBLE_BASE_URL,
    encode_image_to_data_url,
    extract_openai_message_text,
    normalize_keywords,
    parse_json_object_from_text,
    post_json,
    resolve_endpoint,
)
from utils.errors import AiServiceError, AiTimeoutError


class QwenCaptionProvider(BaseCaptionProvider):
    def analyze(
        self,
        image: Any,
        *,
        device: str,
        model_manager: Any,
        configured_provider: str,
        resolved_provider: str,
    ) -> Dict[str, Any]:
        base_data = {
            "description": "",
            "keywords": [],
            "subject_tags": [],
            "action_tags": [],
            "scene_tags": [],
            "ocr": "",
        }

        api_key = (getattr(settings, "CAPTION_CLOUD_API_KEY", "") or "").strip()
        if not api_key:
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": "caption cloud api key missing"},
            )

        json_shape = '{"description":"","keywords":[],"subject_tags":[],"action_tags":[],"scene_tags":[],"ocr":"","face_count":0,"person_count":0}'
        vision_text_rules = (
            "【ocr】逐字转写整张图里能看清的文字（边角、分屏、文档区与人物区域一样要扫到），"
            "按阅读顺序用空格分段，不要翻译、不要概括；没有文字则空字符串。"
        )
        count_rules = (
            "【face_count】非负整数：图中可见、可辨认为「人脸」的个数（含侧脸、远景小脸；完全无法判断则填 0）。"
            "【person_count】非负整数：图中可见「人物」数量（含背影、远景人形、仅身体不露脸者；可与 face_count 不同；无法判断则填 0）。"
        )
        model = getattr(settings, "CAPTION_CLOUD_MODEL", "") or "qwen3-vl-plus"
        prompt = (
            "请分析这张图片，并严格输出一个 JSON 对象，不要输出 Markdown 或额外解释。"
            f"JSON 结构必须为 {json_shape}。"
            "【description】用一到两句简体中文客观描述画面主要内容，可写清主体、动作与场景；允许稍完整，但不要用华丽长句。"
            "【keywords】输出 4 到 10 个「检索用」短词：优先口语化、用户会搜的说法（如 宝宝、吃饭、客厅、户外）；"
            "若 description 里出现较长称呼或地名，可在此给出更短的同义说法（如 宝宝、公园）；"
            "不要与下面三类 tags 逐字重复堆砌，可少量同义补全。"
            "【subject_tags】1 到 4 个主体：谁/什么（人物/宠物/人群），每条优先 2～6 个汉字，尽量 2～4 字；"
            "如「宝宝」「妈妈」「爸爸」「多人」「宠物」。"
            "【action_tags】1 到 4 个动作或状态：每条优先 2～6 个汉字，尽量 2～4 字；"
            "如「吃饭」「睡觉」「玩耍」「抱着」「看电视」。"
            "【scene_tags】1 到 6 个场景或典型物件/地点：每条优先 2～8 个汉字；"
            "如「餐椅」「卧室」「客厅」「户外」「婴儿车」。"
            + vision_text_rules
            + count_rules
            + "keywords 与 subject_tags、action_tags、scene_tags 四个数组中的每一项均须为简短名词或动宾短语，不要输出完整句子；"
            "避免单条超过 8 字的冗长定语；"
            "subject_tags / action_tags / scene_tags 职责分明，同一词尽量只放在最合适的一类；"
            "若无法判断，对应字段返回空字符串或空数组。"
        )
        max_tokens = int(getattr(settings, "CAPTION_MAX_TOKENS", 150) or 150)
        max_tokens = max(
            max_tokens,
            int(getattr(settings, "CAPTION_CLOUD_VISION_OCR_MAX_TOKENS", 1024) or 1024),
        )
        endpoint = resolve_endpoint(
            getattr(settings, "CAPTION_CLOUD_BASE_URL", "") or "",
            DEFAULT_QWEN_COMPATIBLE_BASE_URL,
            "chat/completions",
        )
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": encode_image_to_data_url(image)}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": max_tokens,
        }

        try:
            response = post_json(endpoint, payload, api_key, float(getattr(settings, "CAPTION_TIMEOUT_SECONDS", 30.0) or 30.0))
            raw_text = extract_openai_message_text(response)
            data = _coerce_caption_response(raw_text)
            return build_module_result(status=MODULE_STATUS_SUCCESS, data=data)
        except AiTimeoutError as exc:
            logger.warning("qwen caption timeout: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_TIMEOUT, "message": str(exc)},
            )
        except AiServiceError as exc:
            logger.warning("qwen caption failed: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
            )
        except Exception as exc:
            logger.warning("qwen caption unexpected error: %s" % exc)
            return build_module_result(
                status=MODULE_STATUS_FAILED,
                data=base_data,
                error={"code": AI_SERVICE_ERROR, "message": str(exc)},
            )


def _coerce_int_for_count(value: Any) -> int:
    """解析 JSON 中的 face_count / person_count，非法则 0。"""
    if value is None:
        return 0
    try:
        n = int(round(float(value)))
        return n if n >= 0 else 0
    except (TypeError, ValueError):
        return 0


def _coerce_caption_response(raw: str) -> Dict[str, Any]:
    obj = parse_json_object_from_text(raw) or {}
    return {
        "description": str(obj.get("description") or "").strip(),
        "keywords": _coerce_str_list(obj.get("keywords")),
        "subject_tags": normalize_keywords(_coerce_str_list(obj.get("subject_tags"))),
        "action_tags": normalize_keywords(_coerce_str_list(obj.get("action_tags"))),
        "scene_tags": normalize_keywords(_coerce_str_list(obj.get("scene_tags"))),
        "ocr": str(obj.get("ocr") or "").strip(),
        "face_count": _coerce_int_for_count(obj.get("face_count")),
        "person_count": _coerce_int_for_count(obj.get("person_count")),
    }


def _coerce_str_list(value: Any) -> list:
    if not isinstance(value, list):
        return []
    return [str(x).strip() for x in value if str(x).strip()]
