# -*- coding: utf-8 -*-
"""导图 × 单人猜猜呗联动的后端：预选（该开哪几张图）和图组存储（按方案记住用户选的图）。

一道题 = 题库里的一个角色。一张图「覆盖」这道题，满足任一条：
- 图里有作品卡的 subject_id，属于这个角色的「作品列表」（绑定作品 + 当前模式下全部登场作品，和单人猜猜呗建会话时
  分组用的是同一份，见 solo/session.py 的 pool_with_works）；
- 图里有作品卡的 char_id 就是这个角色。
只按角色比会漏：方案把角色绑到续作 / 前传，而图里放的是正片，代表角色也不是他；按作品比才能对上。

预选 = 贪心：每步选「新增覆盖最多」的图，新增一样多就选更近编辑过的（edited_at，没有就用生成日期）；
覆盖率达到 target、没有新增、或选满 cap 张就停。
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from . import settings
from .maps import MAPS, MapIndex, _ID, file_lock
from .solo.feedback import SoloError
from .solo.session import atomic_write_json, pool_with_works
from .storage import StorageError, _ts_key, check_plan_name, now_iso
from .store import C_HEAT, C_NAME

DEFAULT_CAP = 8
DEFAULT_TARGET = 0.95
MAX_CAP = 100
MAX_SET_MAPS = 1000                 # 一个图组最多存多少张图
_CTRL = re.compile(r"[\x00-\x1f]")


# ---------------------------------------------------------------- 覆盖和贪心（纯函数）
def cover_map(pool_works: Dict[int, Sequence[int]], index: MapIndex) -> Dict[str, List[int]]:
    """图 id -> 它覆盖的题库角色 id（升序）。只含覆盖 ≥ 1 题的图。
    pool_works：题库角色 id -> 作品 id 列表（绑定作品 + 全部登场作品）。"""
    subject_chars: Dict[int, List[int]] = defaultdict(list)
    for cid, works in pool_works.items():
        for w in works:
            subject_chars[w].append(cid)
    out: Dict[str, List[int]] = {}
    for mid in index.summaries:
        cov = set()
        for s in index.subjects[mid]:
            cov.update(subject_chars.get(s, ()))
        cov.update(c for c in index.chars[mid] if c in pool_works)
        if cov:
            out[mid] = sorted(cov)
    return out


def edited_key(summary: Dict[str, Any]) -> float:
    """排序用的「最近编辑」时间戳；没有时间的排最后。"""
    return _ts_key(summary.get("edited_at"))


def greedy_pick(covers: Dict[str, Sequence[int]], edited: Dict[str, float], total: int, cap: int,
                target: float) -> List[str]:
    """按贪心顺序返回选中的图 id。新增覆盖一样多 → edited 大（更近）的；还一样 → 图 id 小的（让结果可复现）。"""
    sets = {m: set(c) for m, c in covers.items()}
    covered: set = set()
    picked: List[str] = []
    chosen: set = set()
    while total > 0 and len(picked) < cap and len(covered) / total < target:
        best: Optional[str] = None
        best_key = None
        for m in sorted(sets):
            if m in chosen:
                continue
            gain = len(sets[m] - covered)
            if gain == 0:
                continue
            key = (gain, edited.get(m, float("-inf")))
            if best_key is None or key > best_key:
                best, best_key = m, key
        if best is None:
            break
        picked.append(best)
        chosen.add(best)
        covered |= sets[best]
    return picked


def check_cap(v: Any) -> int:
    if v is None:
        return DEFAULT_CAP
    if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= MAX_CAP:
        raise SoloError(422, "bad_cap", f"最多选几张图（cap）要是 1 到 {MAX_CAP} 的整数")
    return v


def check_target(v: Any) -> float:
    if v is None:
        return DEFAULT_TARGET
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1 or v != v:
        raise SoloError(422, "bad_target", "目标覆盖率（target）要是大于 0、不超过 1 的数")
    return float(v)


# ---------------------------------------------------------------- 预选
def preselect(snap: Any, spec: Any, cap: Any = None, target: Any = None) -> Dict[str, Any]:
    """方案 → 预选结果。方案求值和单人猜猜呗建会话是同一个函数（pool_with_works），题库为空 → 422 empty_pool。"""
    cap, target = check_cap(cap), check_target(target)
    ev, pool, bound, works = pool_with_works(snap, spec)
    index = MAPS.index()
    covers = cover_map(works, index)
    edited = {m: edited_key(index.summaries[m]) for m in covers}
    picked = greedy_pick(covers, edited, len(pool), cap, target)
    covered = set()
    for m in picked:
        covered.update(covers[m])
    any_covered = set()
    for cov in covers.values():
        any_covered.update(cov)

    maps_out = []
    for m in sorted(covers, key=lambda m: (-len(covers[m]), -edited[m], m)):
        s = index.summaries[m]
        maps_out.append({"id": m, "title": s["title"], "group": s["group"], "source": s["source"],
                         "edited_at": s["edited_at"], "covers": covers[m]})

    # 全题库（按热度降序）：前端勾选 / 取消图以后，本地算「哪些人没覆盖」要用名字和绑定作品
    ordered = sorted(pool, key=lambda c: (-snap.C[c][C_HEAT], c))
    bound_ids = sorted({bound[c] for c in ordered if bound[c] is not None})
    brief = snap.subject_brief(bound_ids) if bound_ids else {}

    def brief_char(c: int) -> Dict[str, Any]:
        return {"char_id": c, "name": snap.C[c][C_NAME], "bound_work_id": bound[c],
                "bound_work_name": brief.get(bound[c], {}).get("name") if bound[c] is not None else None}

    pool_out = [brief_char(c) for c in ordered]
    uncovered = [p for p in pool_out if p["char_id"] not in covered]
    return {"pool_total": len(pool), "picked": picked, "covered": len(covered), "maps": maps_out,
            "uncovered": uncovered, "pool": pool_out, "no_map": len(pool) - len(any_covered),
            "no_map_ids": sorted(c for c in pool if c not in any_covered),
            # 读不出来、没参与预选的坏图（文件名不合规 / JSON 损坏 / 内容校验不过）：[{id, reason}]
            "skipped": [dict(s) for s in index.skipped],
            "errors": ev.errors, "warnings": list(ev.warnings)}


# ---------------------------------------------------------------- 图组存储
def check_plan_key(key: Any) -> str:
    """workbench（工作台当前方案）或 plan:<方案名>（保存过的方案）。"""
    if key == "workbench":
        return key
    if isinstance(key, str) and key.startswith("plan:"):
        name = key[5:]
        # 方案名的规则和保存方案时一样（check_plan_name）：不会有 / : 等字符，也不会有首尾空白
        try:
            if name and name == check_plan_name(name) and not _CTRL.search(name):
                return key
        except StorageError:
            pass
    raise StorageError("plan_key 只能是 workbench 或 plan:<方案名>", 422)


def check_map_ids(ids: Any) -> List[str]:
    if not isinstance(ids, list) or any(not isinstance(i, str) or not _ID.fullmatch(i) for i in ids):
        raise StorageError("map_ids 要是导图 id 的列表（m_ 加 12 位小写十六进制）", 422)
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_SET_MAPS:
        raise StorageError(f"一个图组最多 {MAX_SET_MAPS} 张图", 422)
    return ids


class SetStore:
    """data/maplink_v2/sets.json：{version:1, sets:{plan_key:{map_ids, updated_at}}}。
    读写都拿目录锁（线程锁 + 文件锁）；写 = tmp + os.replace。

    读文件的结果分三种，不能混：
    - 文件不存在：还没存过，当空底稿（GET 回 null，PUT 新建）；
    - 内容坏了（不是 JSON / 形状不对）：先把原文件改名成 sets.json.bad-<时间>，原数据留在那里，改名成功才当空底稿；
    - 其他读不出来（权限、占用、磁盘错误），或坏文件改名也失败：报存储错误（500），这次不读也不写。
      这时绝不能拿空底稿往下走，否则 PUT 会把还在的旧文件整个覆盖掉。"""

    def dir(self) -> Path:
        return Path(settings.data_dir()) / "maplink_v2"

    def _path(self) -> Path:
        return self.dir() / "sets.json"

    def _load(self) -> Dict[str, Any]:
        path = self._path()
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return {"version": 1, "sets": {}}
        except OSError as e:
            raise StorageError(f"联动图组文件读不出来（{type(e).__name__}），为了不覆盖已存的图组，这次没有改动", 500)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("sets"), dict):
                raise ValueError("形状不对")
            return data
        except (ValueError, RecursionError):
            pass
        # 内容坏了：原数据挪到 .bad 里留着，挪成功才算「还没有」
        stamp = time.time_ns()
        bad, n = f"{path}.bad-{stamp}", 0
        while os.path.exists(bad):                    # Windows 的时钟只有毫秒级：连坏两次不能互相覆盖备份
            n += 1
            bad = f"{path}.bad-{stamp}-{n}"
        try:
            os.replace(path, bad)
        except OSError as e:
            raise StorageError(f"联动图组文件内容损坏，备份也没成功（{type(e).__name__}），为了不丢已存的图组，这次没有改动", 500)
        return {"version": 1, "sets": {}}

    def get(self, plan_key: str) -> Optional[Dict[str, Any]]:
        plan_key = check_plan_key(plan_key)
        with file_lock(self.dir() / ".lock"):
            item = self._load()["sets"].get(plan_key)
        if not isinstance(item, dict) or not isinstance(item.get("map_ids"), list):
            return None
        return {"plan_key": plan_key, "map_ids": item["map_ids"], "updated_at": item.get("updated_at")}

    def put(self, plan_key: str, map_ids: Any) -> Dict[str, Any]:
        plan_key = check_plan_key(plan_key)
        ids = check_map_ids(map_ids)
        with file_lock(self.dir() / ".lock"):
            data = self._load()
            now = now_iso()
            data["sets"][plan_key] = {"map_ids": ids, "updated_at": now}
            atomic_write_json(str(self._path()), data)
        return {"plan_key": plan_key, "map_ids": ids, "updated_at": now}


SETS = SetStore()
