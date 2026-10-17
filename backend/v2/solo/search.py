# -*- coding: utf-8 -*-
"""单人版容错搜索服务：把库里的角色 / 作品名字（加上旁路别名文件）建成 fuzzy.FuzzyIndex，回答 GET /v2/solo/search。

- 角色 = 库里全部角色；作品 = 全部「搜索可见」的作品（S_VISIBLE，和 /v2/suggest?kind=work 同一批）。
  名字来源：display_name、name、name_cn，再加别名旁路文件（和库同目录的 search_aliases.sqlite，
  随数据库一起在 Release 里下载；没有这个文件就只用库里的三个名字）。
- 索引在后台线程里建（启动后、库快照切换后、或第一次有人搜的时候）。没建好时用严格规则
  （backend.v2.router._rank_matches，和 /v2/suggest 一样），响应里 fuzzy=false。
- 换库时先丢掉旧索引再建新的（避免两份索引同时占内存），建的这段时间走严格规则。
- 只读：不写任何文件，不改库。
"""
from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

from ..store import (C_HEAT, C_NAME, HUB, S_HEAT, S_NAME, S_TYPE, S_VISIBLE, S_YEAR, TYPE_NAME, StaleSnapshot, open_ro)
from . import fuzzy

RETRY_AFTER_FAIL_SEC = 60.0
MAX_ALIAS_PARTS = 8
# 别名里有些是「甲、乙、丙」「A / B」这样连着写的，拆开再各收一份（整串也留着）
_SPLIT = re.compile(r"\s*[、；;／]\s*|\s+/\s+")


def alias_path_for(db_path: str) -> str:
    d = os.path.dirname(os.path.abspath(db_path))
    return os.path.join(d, "search_aliases.sqlite")


def split_alias(a: str) -> List[str]:
    parts = [p.strip() for p in _SPLIT.split(a)]
    parts = [p for p in parts if len(p) >= 2]
    return parts[:MAX_ALIAS_PARTS] if len(parts) > 1 else []


def _load_aliases(db_path: str) -> Tuple[Dict[int, List[str]], Dict[int, List[str]], Optional[dict]]:
    """读旁路别名文件 -> (角色别名, 作品别名, meta)。文件没有 / 读不了 → 空。"""
    p = alias_path_for(db_path)
    if not os.path.isfile(p):
        return {}, {}, None
    ca: Dict[int, List[str]] = {}
    sa: Dict[int, List[str]] = {}
    try:
        conn = open_ro(p)
        try:
            meta = {k: v for k, v in conn.execute("SELECT key, value FROM meta")}
            for i, a in conn.execute("SELECT id, alias FROM char_alias"):
                ca.setdefault(i, []).append(a)
            for i, a in conn.execute("SELECT id, alias FROM subject_alias"):
                sa.setdefault(i, []).append(a)
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return {}, {}, None
    return ca, sa, meta


def _with_splits(names: List[str], aliases: Optional[List[str]]) -> List[str]:
    if not aliases:
        return names
    out = list(names)
    out.extend(aliases)
    for a in aliases:
        if "、" in a or "；" in a or ";" in a or "／" in a or " / " in a:
            out.extend(split_alias(a))
    return out


def load_entities(snap) -> Tuple[list, list, dict]:
    """(角色实体, 作品实体, 信息)。实体 = (id, 热度, [名字…], 正式名字个数)，已按 (热度降序, id 升序) 排好。
    名字列表里前面是库里的名字，后面是别名（含拆开的）。"""
    ca, sa, meta = _load_aliases(snap.path)
    C, S = snap.C, snap.S
    chars: List[Tuple[int, int, List[str]]] = []
    works: List[Tuple[int, int, List[str]]] = []
    conn = snap.connect()
    try:
        for cid, dn, n, ncn in conn.execute("SELECT id, display_name, name, name_cn FROM character"):
            c = C.get(cid)
            if c is None:
                continue
            names = [x for x in (c[C_NAME], dn, n, ncn) if x]
            chars.append((cid, c[C_HEAT], _with_splits(names, ca.get(cid)), len(names)))
        for sid, dn, n, ncn in conn.execute("SELECT id, display_name, name, name_cn FROM subject"):
            s = S.get(sid)
            if s is None or not s[S_VISIBLE]:
                continue
            names = [x for x in (s[S_NAME], dn, n, ncn) if x]
            works.append((sid, s[S_HEAT], _with_splits(names, sa.get(sid)), len(names)))
    finally:
        conn.close()
    chars.sort(key=lambda e: (-e[1], e[0]))
    works.sort(key=lambda e: (-e[1], e[0]))
    info = {"aliases": bool(meta), "alias_dump": (meta or {}).get("dump_name"),
            "char_aliases": sum(len(v) for v in ca.values()), "subject_aliases": sum(len(v) for v in sa.values())}
    return chars, works, info


class Built:
    __slots__ = ("sig", "char", "work", "seconds", "info", "built_at")

    def __init__(self, sig, char, work, seconds, info):
        self.sig, self.char, self.work, self.seconds, self.info = sig, char, work, seconds, info
        self.built_at = time.time()


class SearchService:
    def __init__(self):
        self._lock = threading.Lock()
        self._built: Optional[Built] = None
        self._building = None            # 正在为哪个 sig 建
        self._failed: Optional[Tuple[Any, float, str]] = None
        self._thread: Optional[threading.Thread] = None

    # ---------------------------------------------------------------- 建索引
    def kick(self, snap=None) -> None:
        """后台建索引（已经有、或正在建同一份库的，什么都不做）。snap 不给就用当前快照。"""
        try:
            snap = snap or HUB.current()
        except Exception:  # noqa: BLE001  没库 / 读库失败：以后有人搜的时候再试
            return
        self.ensure(snap)

    def ensure(self, snap) -> Optional[Built]:
        """这份快照的索引建好了就返回，没建好返回 None 并（必要时）开始建。"""
        b = self._built
        if b is not None and b.sig == snap.sig:
            return b
        with self._lock:
            b = self._built
            if b is not None and b.sig == snap.sig:
                return b
            if b is not None:
                self._built = None       # 库换了：旧索引不要了，先放掉内存
            if self._building == snap.sig:
                return None
            f = self._failed
            if f is not None and f[0] == snap.sig and time.time() - f[1] < RETRY_AFTER_FAIL_SEC:
                return None
            self._building = snap.sig
            t = threading.Thread(target=self._build, args=(snap,), name="solo-search-index", daemon=True)
            self._thread = t
            t.start()
        return None

    def _build(self, snap) -> None:
        t0 = time.perf_counter()
        try:
            chars, works, info = load_entities(snap)
            ci = fuzzy.FuzzyIndex(chars)
            del chars
            wi = fuzzy.FuzzyIndex(works)
            del works
            info.update({"char_entities": len(ci.ent_ids), "char_rows": ci.n_rows,
                         "work_entities": len(wi.ent_ids), "work_rows": wi.n_rows})
            built = Built(snap.sig, ci, wi, time.perf_counter() - t0, info)
            with self._lock:
                if self._building == snap.sig:
                    self._built = built
                    self._failed = None
        except StaleSnapshot:
            pass                          # 构建中库又被换了：下一次请求会按新快照重新建
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            with self._lock:
                self._failed = (snap.sig, time.time(), f"{type(e).__name__}: {e}")
        finally:
            with self._lock:
                if self._building == snap.sig:
                    self._building = None

    def wait_ready(self, snap, timeout: float = 120.0) -> Optional[Built]:
        """（测试用）等索引建好。"""
        t_end = time.time() + timeout
        while time.time() < t_end:
            b = self.ensure(snap)
            if b is not None:
                return b
            with self._lock:
                if self._building is None and self._failed is not None and self._failed[0] == snap.sig:
                    return None                  # 建失败了，而且现在没有在重试
            time.sleep(0.05)
        return None

    def reset(self) -> None:
        """（测试用）丢掉索引和失败记录。"""
        with self._lock:
            self._built = None
            self._failed = None
            self._building = None

    def status(self) -> Dict[str, Any]:
        b, f = self._built, self._failed
        return {"ready": b is not None, "building": self._building is not None,
                "seconds": round(b.seconds, 1) if b else None, "info": b.info if b else None,
                "error": f[2] if f else None}

    # ---------------------------------------------------------------- 搜索
    def search(self, snap, kind: str, q: str, limit: int) -> Dict[str, Any]:
        """-> {"items": [...], "fuzzy": bool}。kind 已校验过（character / work）。"""
        if not "".join((q or "").split()):
            return {"items": [], "fuzzy": self._built is not None and self._built.sig == snap.sig}
        b = self.ensure(snap)
        if b is None:
            return {"items": self._strict(snap, kind, q, limit), "fuzzy": False}
        idx = b.char if kind == "character" else b.work
        items = []
        for tier, _score, ei, row in idx.search(q, limit):
            eid = idx.ent_ids[ei]
            it = self._item(snap, kind, eid, idx.ent_counts[ei])
            if it is None:
                continue
            raw = idx.row_raw(row)
            it["matched"] = raw if raw != it["value"] else None
            it["match"] = fuzzy.TIER_NAMES[tier]
            items.append(it)
        return {"items": items, "fuzzy": True}

    @staticmethod
    def _item(snap, kind: str, eid: int, count: int) -> Optional[Dict[str, Any]]:
        """value / label / count / id：和 /v2/suggest 同一种 kind 的格式完全一致。"""
        if kind == "character":
            c = snap.C.get(eid)
            if c is None:
                return None
            v = c[C_NAME]
            w = snap.best_work(eid)
            wn = snap.S[w][S_NAME] if w in snap.S else None
            return {"id": eid, "value": v, "label": f"{v}（{wn}）" if wn else v, "count": count}
        s = snap.S.get(eid)
        if s is None:
            return None
        v = s[S_NAME]
        return {"id": eid, "value": v, "label": f"{v}（{s[S_YEAR] or '年份不明'} · {TYPE_NAME.get(s[S_TYPE], s[S_TYPE])}）",
                "count": count}

    @staticmethod
    def _strict(snap, kind: str, q: str, limit: int) -> List[Dict[str, Any]]:
        """索引没建好时用的严格规则（前缀 > 包含，同档按热度）。"""
        from ..router import _rank_matches
        qn = (q or "").strip().casefold()
        out: List[Dict[str, Any]] = []
        if kind == "work":
            names = snap.subject_search_names()
            S = snap.S
            items = [(S[sid][S_NAME], S[sid][S_HEAT], names.get(sid, ""), sid) for sid in S if S[sid][S_VISIBLE]]
        else:
            names = snap.char_search_names()
            C = snap.C
            items = [(C[cid][C_NAME], C[cid][C_HEAT], names.get(cid, ""), cid) for cid in C]
        for v, c, key, eid in _rank_matches(q, items, limit):
            it = SearchService._item(snap, kind, eid, c)
            if it is None:
                continue
            keys = key.split("|") if key else [v.casefold()]
            if qn in keys:
                m = "exact"
            elif any(k.startswith(qn) for k in keys):
                m = "prefix"
            else:
                m = "contains"
            it["matched"] = None
            it["match"] = m
            out.append(it)
        return out


SEARCH = SearchService()


def install() -> None:
    """让库快照切换后自动在后台建索引；已经有快照就现在建。由 backend/app.py 启动时调用。"""
    hooks = getattr(HUB, "snapshot_hooks", None)
    if hooks is not None and SEARCH.kick not in hooks:
        hooks.append(SEARCH.kick)
    snap = getattr(HUB, "_snap", None)
    if snap is not None:
        SEARCH.kick(snap)
