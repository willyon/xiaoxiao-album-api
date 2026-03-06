#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
向量搜索服务（基于 hnswlib 的 ANN 索引）

- 从 SQLite 的 media_embeddings + media 表加载所有媒体向量
- 在内存中构建 hnswlib 索引（space='cosine', dim=1152）
- 按 user_id 过滤，返回当前用户下最相似的媒体
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

import hnswlib
import numpy as np
import sqlite3

from logger import logger


_index: Optional[hnswlib.Index] = None
_label_meta: Dict[int, Dict[str, int]] = {}
_dim: int = 1152
_initialized: bool = False


def _get_db_path() -> Path:
  """
  计算 SQLite 数据库路径：
  python-ai-service/../database.db
  """
  base_dir = Path(__file__).resolve().parent.parent  # python-ai-service/
  return base_dir.parent / "database.db"


def init_hnsw_index(ef_construction: int = 200, m: int = 16) -> None:
  """
  从 SQLite 全量加载 media_embeddings，构建 hnswlib 索引。
  该函数在服务启动时调用一次，后续重复调用会直接返回。
  """
  global _index, _label_meta, _initialized

  if _initialized:
    return

  db_path = _get_db_path()
  if not db_path.exists():
    logger.error("向量索引初始化失败：数据库文件不存在", details={"db_path": str(db_path)})
    return

  try:
    logger.info("📦 开始构建 hnsw 向量索引（单机）", details={"db_path": str(db_path)})

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 仅加载未删除媒体的 embedding
    cur.execute(
      """
      SELECT e.media_id, e.vector, m.user_id
      FROM media_embeddings e
      INNER JOIN media m ON e.media_id = m.id
      WHERE m.deleted_at IS NULL
      """
    )

    rows = cur.fetchall()
    conn.close()

    if not rows:
      logger.warning("向量索引初始化：没有可用的 media_embeddings 记录")
      _initialized = True
      return

    vectors: List[np.ndarray] = []
    labels: List[int] = []
    _label_meta = {}

    for row in rows:
      blob = row["vector"]
      if blob is None:
        continue
      try:
        vec = np.frombuffer(blob, dtype=np.float32)
        if vec.size != _dim:
          # 维度不匹配的向量跳过
          continue
        media_id = int(row["media_id"])
        user_id = int(row["user_id"])
        vectors.append(vec)
        labels.append(media_id)
        _label_meta[media_id] = {"media_id": media_id, "user_id": user_id}
      except Exception:
        continue

    if not vectors:
      logger.warning("向量索引初始化：没有有效的向量可用于构建索引")
      _initialized = True
      return

    data = np.stack(vectors).astype(np.float32)
    labels_arr = np.array(labels, dtype=np.int64)

    # 创建 hnsw 索引
    index = hnswlib.Index(space="cosine", dim=_dim)
    index.init_index(max_elements=data.shape[0], ef_construction=ef_construction, M=m)
    index.add_items(data, labels_arr)
    index.set_ef(64)

    _index = index
    _initialized = True

    logger.info(
      "✅ 向量索引构建完成",
      details={
        "num_vectors": int(data.shape[0]),
        "dim": _dim,
        "unique_users": len({meta["user_id"] for meta in _label_meta.values()}),
      },
    )
  except Exception as exc:
    logger.error("❌ 向量索引初始化失败", details={"error": str(exc)})
    _index = None
    _initialized = False


def ann_search(user_id: int, query_vector: List[float], top_k: int = 50) -> List[Dict[str, float]]:
  """
  使用 hnsw 索引进行 ANN 搜索，只返回当前用户的媒体。

  Args:
      user_id: 当前用户 ID
      query_vector: 查询向量（1152 维）
      top_k: 返回结果数量
  """
  if _index is None or not _initialized:
    # 尝试懒加载一次
    init_hnsw_index()
    if _index is None:
      logger.warning("ann_search: 向量索引未初始化，返回空结果", details={"user_id": user_id})
      return []

  if not query_vector:
    return []

  try:
    q = np.array(query_vector, dtype=np.float32)
    if q.size != _dim:
      logger.warning(
        "ann_search: 查询向量维度不匹配",
        details={"expected": _dim, "actual": int(q.size)},
      )
      return []

    # hnswlib 的 cosine 距离是 1 - cosine_similarity
    # 这里多取一些结果，然后按 user_id 过滤
    total_count = _index.get_current_count()
    k = min(max(top_k * 5, top_k), total_count)
    labels, distances = _index.knn_query(q, k=k)
    labels = labels[0]
    distances = distances[0]

    logger.info(
      "ann_search: hnsw 查询完成",
      details={
        "user_id": user_id,
        "total_vectors": total_count,
        "knn_k": k,
        "candidates_before_filter": len(labels),
      },
    )

    results: List[Dict[str, float]] = []
    for label, dist in zip(labels, distances):
      meta = _label_meta.get(int(label))
      if not meta:
        continue
      if meta["user_id"] != int(user_id):
        continue
      score = float(1.0 - float(dist))
      results.append({"media_id": meta["media_id"], "score": score})
      if len(results) >= top_k:
        break

    logger.info(
      "ann_search: 用户过滤后结果",
      details={"user_id": user_id, "results_count": len(results)},
    )

    return results
  except Exception as exc:
    logger.error("ann_search 失败", details={"error": str(exc)})
    return []

