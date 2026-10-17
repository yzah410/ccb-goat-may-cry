# -*- coding: utf-8 -*-
"""标签分档（第 1–4 档）和公式：存在 data/tag_tiers.json，前端设置页和开局问卷读写。

- 分档决定导图先按哪些标签分岔（canvas_logic._find_best_strategy）、标签笔记的分组、候选卡片哪些标签加粗。
- 公式 = 每局开头先猜的两三个角色。开局问卷按公式分档：两人的标签 → 第 1 档，第 3 个人新增的 → 第 2 档，其余 → 第 3 档。
  分档由前端算好再存，后端只管校验和生效。
- 没有这个文件 = 还没选过公式：分档用默认值（DEFAULT_TIERS），接口返回 configured: false，前端弹开局问卷。
- 生效方式：原地改 canvas_logic.TAG_GROUPS 和 tagnote.TAG_GROUPS_ORDERED 里 G_1–G_4 的内容；
  其他模块 import 的是同一个字典对象，会直接看到新分档。来源、播放形式、制作公司三组固定，不归这里管。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional

from ..canvas_logic import TAG_GROUPS
from . import settings
from .storage import StorageError, _atomic_write, now_iso
from .tagnote import TAG_GROUPS_ORDERED

TIER_KEYS = ("G_1", "G_2", "G_3", "G_4")
FIXED_KEYS = ("G_source", "G_format", "G_staff")
FILE_NAME = "tag_tiers.json"
VERSION = 1
MAX_TAG_LEN = 40
MAX_TAGS = 300

# 默认的 4 档。导入时 TAG_GROUPS_ORDERED 还没被改过，这里留一份不变的副本。
DEFAULT_TIERS: Dict[str, List[str]] = {g: list(TAG_GROUPS_ORDERED[g]) for g in TIER_KEYS}

_LOCK = threading.Lock()
_state: Dict[str, Any] = {"configured": False, "formula": None, "updated": None, "error": None}


def path() -> str:
    return os.path.join(settings.data_dir(), FILE_NAME)


def _apply(tiers: Dict[str, List[str]]) -> None:
    for g in TIER_KEYS:
        TAG_GROUPS_ORDERED[g] = list(tiers[g])
        TAG_GROUPS[g] = set(tiers[g])


def current_tiers() -> Dict[str, List[str]]:
    return {g: list(TAG_GROUPS_ORDERED[g]) for g in TIER_KEYS}


def check_tiers(raw: Any) -> Dict[str, List[str]]:
    if not isinstance(raw, dict) or set(raw) != set(TIER_KEYS):
        raise StorageError("分档要正好是 G_1、G_2、G_3、G_4 四档")
    fixed = set().union(*(TAG_GROUPS[k] for k in FIXED_KEYS))
    seen: Dict[str, str] = {}
    out: Dict[str, List[str]] = {}
    for g in TIER_KEYS:
        lst = raw[g]
        if not isinstance(lst, list):
            raise StorageError(f"{g} 要是标签列表")
        tags: List[str] = []
        for t in lst:
            if not isinstance(t, str) or not t.strip():
                raise StorageError(f"{g} 里有空标签")
            t = t.strip()
            if len(t) > MAX_TAG_LEN or any(ord(c) < 32 for c in t):
                raise StorageError(f"标签「{t[:MAX_TAG_LEN]}」太长或带了控制字符")
            if t in fixed:
                raise StorageError(f"「{t}」是来源 / 播放形式 / 制作公司，不能放进分档")
            if t in seen:
                raise StorageError(f"「{t}」同时在 {seen[t]} 和 {g} 里，一个标签只能在一档")
            seen[t] = g
            tags.append(t)
        out[g] = tags
    if len(seen) > MAX_TAGS:
        raise StorageError(f"分档里最多放 {MAX_TAGS} 个标签")
    return out


def check_formula(raw: Any) -> Optional[Dict[str, Any]]:
    """公式：null（跳过问卷 / 手动分档）或 {chars: [{id, name}] 2–3 个}。"""
    if raw is None:
        return None
    chars = raw.get("chars") if isinstance(raw, dict) else None
    if not isinstance(chars, list) or not 2 <= len(chars) <= 3:
        raise StorageError("公式要有 2 或 3 个角色")
    out = []
    for c in chars:
        cid = c.get("id") if isinstance(c, dict) else None
        name = c.get("name") if isinstance(c, dict) else None
        if not isinstance(cid, int) or isinstance(cid, bool) or cid <= 0 or not isinstance(name, str) or not 0 < len(name) <= 80:
            raise StorageError("公式里的角色要有 id（正整数）和名字（1–80 个字）")
        out.append({"id": cid, "name": name})
    if len({c["id"] for c in out}) != len(out):
        raise StorageError("公式里有重复的角色")
    return {"chars": out}


def load() -> None:
    """启动时读一次文件并生效。文件坏了：用默认分档，configured 当成 false（前端会重新问），error 里写原因。"""
    with _LOCK:
        p = path()
        _state.update(configured=False, formula=None, updated=None, error=None)
        tiers = DEFAULT_TIERS
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                tiers = check_tiers(data.get("tiers"))
                _state.update(configured=True, formula=check_formula(data.get("formula")), updated=data.get("updated"))
            except (OSError, ValueError, AttributeError, StorageError) as e:
                msg = e.message if isinstance(e, StorageError) else f"{type(e).__name__}: {e}"
                _state["error"] = f"{FILE_NAME} 读不了，先用默认分档：{msg}"
                tiers = DEFAULT_TIERS
        _apply(tiers)


def save(body: Any) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise StorageError("要传 {formula, tiers}")
    tiers = check_tiers(body.get("tiers"))
    formula = check_formula(body.get("formula"))
    with _LOCK:
        data = {"version": VERSION, "formula": formula, "tiers": tiers, "updated": now_iso()}
        _atomic_write(path(), data)
        _apply(tiers)
        _state.update(configured=True, formula=formula, updated=data["updated"], error=None)
    return snapshot()


def snapshot() -> Dict[str, Any]:
    return {
        "configured": _state["configured"],
        "formula": _state["formula"],
        "tiers": current_tiers(),
        "defaults": {g: list(v) for g, v in DEFAULT_TIERS.items()},
        "fixed": {k: sorted(TAG_GROUPS[k]) for k in FIXED_KEYS},
        "updated": _state["updated"],
        "error": _state["error"],
    }
