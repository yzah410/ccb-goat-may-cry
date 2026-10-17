# -*- coding: utf-8 -*-
"""出题器数据层：把 SQLite 里工作台要用的数据读进内存，读完立刻关连接。

- `HUB.current()` 返回当前快照（Snapshot）。每次调用都 stat 一下库文件：路径 / mtime / 大小变了就整份重载。
- 快照里「基础数据」（条目排名、角色、登场关系）在重载时一次读完；
  每个模式的画像、(mode, n) 的标签倒排索引、角色标签、声优、作品标签都是**第一次用到时**才读，读完缓存在快照上。
- 懒加载时要重新开一次只读连接：开之前先核对文件签名没变，变了就抛 StaleSnapshot，调用方换新快照重算。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from array import array
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from . import settings

# ---------------------------------------------------------------- 常量
MODES: List[Dict[str, Any]] = [
    {"id": "anime", "label": "动画", "types": [2]},
    {"id": "game", "label": "游戏", "types": [4]},
    {"id": "book", "label": "书籍", "types": [1]},
    {"id": "real", "label": "三次元", "types": [6]},
    {"id": "all", "label": "全部", "types": [1, 2, 4, 6]},
]
MODE_IDS = [m["id"] for m in MODES]
MODE_LABEL = {m["id"]: m["label"] for m in MODES}
TYPE_NAME = {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}
REL_CODE = {"主角": 1, "配角": 2, "客串": 3, "闲角": 4, "旁白": 5, "声库": 6}
REL_NAME = {1: "主角", 2: "配角", 3: "客串", 4: "闲角", 5: "旁白", 6: "声库", 9: "其他"}

# 条目元组下标（只存「有角色登场」的条目）
# S_COUNTS：游戏会不会把这部算进角色登场 = anon_detail = 1（匿名能拿到详情）且不是 locked（上游 getSubjectDetails 对 locked 返回 null）；
#           库里没有 anon_detail 列时退回 nsfw = 0。库里存好的画像（profile / profile_app）也是按这个规则算的。
# S_VISIBLE：匿名搜索能不能搜到 = search_visible = 1；库里没有这一列时退回 nsfw = 0。热度排名、标签词表按它。
S_TYPE, S_NAME, S_YEAR, S_HEAT, S_NSFW, S_DATE, S_COUNTS, S_VISIBLE = range(8)
# 角色元组下标
C_NAME, C_GENDER, C_HEAT = range(3)
# 画像元组下标
P_FALLBACK, P_NAPP, P_EARLIEST, P_LATEST, P_RATING, P_CUT, P_SOURCE = range(7)


class NoDatabase(Exception):
    def __init__(self, candidates: List[str]):
        self.candidates = candidates
        msg = "还没有出题器数据库。找过：" + "；".join(candidates or ["（config.json 里没配 v2.db_path）"])
        super().__init__(msg)


class StaleSnapshot(Exception):
    """库文件在读的过程中被换掉了。"""


def open_ro(path: str) -> sqlite3.Connection:
    """只读连接（file:...?mode=ro）。调用方负责 close。"""
    uri = Path(path).as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=10)


def file_sig(path: str) -> Tuple[str, int, int]:
    st = os.stat(path)
    return (os.path.normcase(os.path.abspath(path)), st.st_mtime_ns, st.st_size)


def _table_names(conn: sqlite3.Connection) -> Set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}


# ---------------------------------------------------------------- 每个模式的画像
class TagIndex:
    """(mode, n) 下每个角色在游戏格子里显示的作品标签，和反过来的倒排索引。"""

    __slots__ = ("mode", "n", "by_char", "by_tag", "built_ms")

    def __init__(self, mode: str, n: int, by_char: Dict[int, Tuple[str, ...]], by_tag: Dict[str, FrozenSet[int]], ms: float):
        self.mode, self.n, self.by_char, self.by_tag, self.built_ms = mode, n, by_char, by_tag, ms


class ModeProfile:
    __slots__ = ("mode", "prof", "tags", "apps", "tag_universe", "_ti", "_ti_lock", "load_ms")

    def __init__(self, mode: str):
        self.mode = mode
        self.prof: Dict[int, tuple] = {}
        self.tags: Dict[int, Tuple[str, ...]] = {}
        self.apps: Dict[int, Tuple[int, ...]] = {}
        self.tag_universe: Dict[str, int] = {}
        self._ti: Dict[int, TagIndex] = {}
        self._ti_lock = threading.Lock()
        self.load_ms = 0.0

    def has_profile(self, cid: int) -> bool:
        p = self.prof.get(cid)
        return bool(p) and (p[P_NAPP] or 0) > 0

    def tag_index(self, n: int) -> TagIndex:
        n = max(0, min(int(n), 30))
        ti = self._ti.get(n)
        if ti is not None:
            return ti
        with self._ti_lock:
            ti = self._ti.get(n)
            if ti is not None:
                return ti
            t0 = time.perf_counter()
            by_char: Dict[int, Tuple[str, ...]] = {}
            acc: Dict[str, List[int]] = defaultdict(list)
            prof = self.prof
            for cid, tags in self.tags.items():
                p = prof.get(cid)
                if not p or not p[P_NAPP]:
                    continue
                cut = p[P_CUT]
                k = n if (cut is None or cut < 0) else max(cut, n)
                sel = tags[:k]
                if sel:
                    by_char[cid] = sel
                    for t in sel:
                        acc[t].append(cid)
            by_tag = {t: frozenset(v) for t, v in acc.items()}
            ti = TagIndex(self.mode, n, by_char, by_tag, (time.perf_counter() - t0) * 1000)
            # 每个模式最多缓存 4 个 n
            if len(self._ti) >= 4:
                self._ti.pop(next(iter(self._ti)))
            self._ti[n] = ti
            return ti


# ---------------------------------------------------------------- 快照
class Snapshot:
    def __init__(self, path: str, sig: Tuple[str, int, int]):
        self.path = path
        self.sig = sig
        self.loaded_at = time.time()
        self.load_ms = 0.0
        self.meta: Dict[str, str] = {}
        self.tables: Set[str] = set()
        self.today: str = time.strftime("%Y-%m-%d")
        # 有角色登场的条目：sid -> (type, display_name, year, heat, nsfw, date, counts, visible)
        self.S: Dict[int, tuple] = {}
        # 用哪一列判断「搜索可见」「算不算登场」（有 search_visible / anon_detail 列就用它们，没有就用 nsfw）
        self.visible_col = "nsfw"
        self.counts_col = "nsfw"
        self.visible_sql = "s.nsfw = 0"        # 给 SQL 用的「搜索可见」条件（表别名 s）
        # 排名用（所有搜索可见的条目）：type -> (sids 按热度降序/同分 id 升序, years, dates 是否未上映)
        self.rank_sids: Dict[int, List[int]] = {}
        self.rank_heat: Dict[int, array] = {}
        self.rank_year: Dict[int, array] = {}
        self.rank_unaired: Dict[int, bytearray] = {}
        self.rank_nodate: Dict[int, bytearray] = {}
        # 角色：cid -> (display_name, gender '男'/'女'/None, heat)
        self.C: Dict[int, tuple] = {}
        # 登场：sid -> [(cid, rel, ord)]；cid -> [(sid, rel)]
        self.s_apps: Dict[int, List[Tuple[int, int, int]]] = {}
        self.c_apps: Dict[int, List[Tuple[int, int]]] = {}
        self.counts: Dict[str, int] = {}
        # 懒加载缓存
        self._lazy: Dict[str, Any] = {}
        self._locks: Dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._locks_guard = threading.Lock()
        self._modes: Dict[str, ModeProfile] = {}
        self._strs: Dict[str, str] = {}      # 字符串去重（标签名在 5 个模式之间共用一份）
        self._nums: Dict[Any, Any] = {}      # 数字去重（年份、评分、条目 id）
        self._pick_cache: Dict[Tuple[int, Tuple[int, ...], str], List[int]] = {}
        self._work_tag_cache: Dict[str, Tuple[FrozenSet[int], FrozenSet[int]]] = {}
        self.cache: "OrderedDict[str, Any]" = OrderedDict()   # 给引擎放求值结果等（按快照隔离）
        self.cache_lock = threading.Lock()

    # ---------------------------------------------------------- 按前缀限量的缓存
    CACHE_LIMITS = {"eval:": 24, "stats:": 64, "sqlcond:": 16}

    def cache_put(self, key: str, value: Any) -> None:
        """写进 self.cache；同一前缀的条目超过上限就丢掉最早的（求值结果、统计、sql 条件的 id 集合可能很大）。"""
        with self.cache_lock:
            self.cache[key] = value
            self.cache.move_to_end(key)
            for prefix, limit in self.CACHE_LIMITS.items():
                if key.startswith(prefix):
                    same = [k for k in self.cache if k.startswith(prefix)]
                    for k in same[:max(0, len(same) - limit)]:
                        self.cache.pop(k, None)
                    break

    # ---------------------------------------------------------- 连接
    def connect(self) -> sqlite3.Connection:
        try:
            now = file_sig(self.path)
        except FileNotFoundError:
            raise StaleSnapshot(self.path)
        if now != self.sig:
            raise StaleSnapshot(self.path)
        return open_ro(self.path)

    def _lock(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks[key]

    def lazy(self, key: str, loader):
        v = self._lazy.get(key)
        if v is not None:
            return v
        with self._lock(key):
            v = self._lazy.get(key)
            if v is not None:
                return v
            v = loader()
            self._lazy[key] = v
            return v

    # ---------------------------------------------------------- 基础数据
    def load_base(self, progress=None) -> None:
        t0 = time.perf_counter()
        conn = self.connect()
        try:
            self.tables = _table_names(conn)
            if "meta" in self.tables:
                self.meta = {k: v for k, v in conn.execute("SELECT key, value FROM meta")}
            self.today = (self.meta.get("today") or time.strftime("%Y-%m-%d"))[:10]
            today = self.today
            if progress:
                progress("读取条目")
            # 所有条目里：搜索可见的进排名表；有角色的另存 S
            scols = {r[1] for r in conn.execute("PRAGMA table_info(subject)")}
            has_sv, has_ad, has_lk = "search_visible" in scols, "anon_detail" in scols, "locked" in scols
            self.visible_col = "search_visible" if has_sv else "nsfw"
            self.counts_col = "anon_detail" if has_ad else "nsfw"
            self.visible_sql = "s.search_visible = 1" if has_sv else "s.nsfw = 0"
            sv_expr = "search_visible" if has_sv else "NULL"
            ad_expr = "anon_detail" if has_ad else "NULL"
            lk_expr = "locked" if has_lk else "NULL"
            with_chars = {r[0] for r in conn.execute("SELECT DISTINCT subject_id FROM appearance")}
            rank_sids: Dict[int, List[int]] = defaultdict(list)
            rank_heat: Dict[int, array] = defaultdict(lambda: array("q"))
            rank_year: Dict[int, array] = defaultdict(lambda: array("h"))
            rank_unaired: Dict[int, bytearray] = defaultdict(bytearray)
            rank_nodate: Dict[int, bytearray] = defaultdict(bytearray)
            S: Dict[int, tuple] = {}
            n_subjects = 0
            cur = conn.execute(
                f"SELECT id, type, display_name, name, year, heat, nsfw, date, {sv_expr}, {ad_expr}, {lk_expr} "
                "FROM subject ORDER BY heat DESC, id ASC")
            for sid, typ, dname, name, year, heat, nsfw, date, sv, ad, lk in cur:
                n_subjects += 1
                heat = int(heat or 0)
                visible = bool(sv) if sv is not None else not nsfw       # 列不存在（或值为空）→ 退回 nsfw = 0
                counts = (bool(ad) if ad is not None else not nsfw) and lk != 1
                if sid in with_chars:
                    S[sid] = (typ, dname or name or str(sid), year, heat, 1 if nsfw else 0, date,
                              1 if counts else 0, 1 if visible else 0)
                if visible:
                    rank_sids[typ].append(sid)
                    rank_heat[typ].append(heat)
                    rank_year[typ].append(int(year) if year is not None else 0)
                    rank_unaired[typ].append(1 if (date and date[:10] >= today) else 0)
                    rank_nodate[typ].append(0 if year is not None else 1)
            self.S = S
            self.rank_sids = dict(rank_sids)
            self.rank_heat = dict(rank_heat)
            self.rank_year = dict(rank_year)
            self.rank_unaired = dict(rank_unaired)
            self.rank_nodate = dict(rank_nodate)
            if progress:
                progress("读取角色")
            C: Dict[int, tuple] = {}
            for cid, dname, name, gender, heat in conn.execute(
                    "SELECT id, display_name, name, gender, heat FROM character"):
                g = gender if gender in ("男", "女") else None
                C[cid] = (dname or name or str(cid), g, int(heat or 0))
            self.C = C
            if progress:
                progress("读取登场关系")
            s_apps: Dict[int, List[Tuple[int, int, int]]] = defaultdict(list)
            c_apps: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
            n_app_rows = 0
            for cid, sid, rel, ordv in conn.execute("SELECT character_id, subject_id, relation, ord FROM appearance"):
                n_app_rows += 1
                rc = REL_CODE.get(rel, 9)
                s_apps[sid].append((cid, rc, int(ordv) if ordv is not None else 1 << 30))
                c_apps[cid].append((sid, rc))
            self.s_apps = dict(s_apps)
            self.c_apps = dict(c_apps)
            self.counts = {
                "visibility_rule": {"rank": self.visible_col, "appearance": self.counts_col},
                "subjects": n_subjects,
                "subjects_with_characters": len(S),
                "characters": len(C),
                "appearances": n_app_rows,
            }
            for t in ("subject_tag", "profile", "profile_tag", "char_tag", "character_va", "char_ext_tag", "person", "voice", "profile_app"):
                if t in self.tables:
                    try:
                        self.counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    except sqlite3.Error:
                        pass
            if "profile" in self.tables:
                self.counts["profile_modes"] = {m: n for m, n in conn.execute("SELECT mode, COUNT(*) FROM profile GROUP BY mode")}
        finally:
            conn.close()
        self.load_ms = (time.perf_counter() - t0) * 1000

    # ---------------------------------------------------------- 条目排名
    def ranked(self, types: Iterable[int], year_from: Optional[int], year_to: Optional[int],
               include_unaired: bool = False, keep=None) -> List[Tuple[int, Optional[int]]]:
        """按热度降序（同分 id 升序）列出符合条件的、搜索可见的条目 [(sid, year)]。
        没有年份（没有规范日期）的条目永远不参与排名：游戏的搜索总带 air_date 范围，它们不会占名次，
        它们里面的角色在游戏里也没有登场（格子全是问号）。keep(sid) 是可选的额外过滤（作品本身的标签）。"""
        lists = []
        need_year = year_from is not None or year_to is not None
        yf = year_from if year_from is not None else -10**6
        yt = year_to if year_to is not None else 10**6
        for t in sorted(set(types)):
            sids = self.rank_sids.get(t)
            if not sids:
                continue
            heats, years = self.rank_heat[t], self.rank_year[t]
            unaired, nodate = self.rank_unaired[t], self.rank_nodate[t]
            out = []
            for i, sid in enumerate(sids):
                if not include_unaired and unaired[i]:
                    continue
                if nodate[i]:
                    continue
                y = years[i]
                if need_year and (y < yf or y > yt):
                    continue
                if keep is not None and not keep(sid):
                    continue
                out.append((-heats[i], sid, y))
            lists.append(out)
        if not lists:
            return []
        if len(lists) == 1:
            return [(sid, y) for _, sid, y in lists[0]]
        merged = [x for lst in lists for x in lst]
        merged.sort(key=lambda x: (x[0], x[1]))
        return [(sid, y) for _, sid, y in merged]

    # ---------------------------------------------------------- 每部作品取角色
    def picked(self, sid: int, roles: Tuple[int, ...], order: str) -> List[int]:
        key = (sid, roles, order)
        v = self._pick_cache.get(key)
        if v is not None:
            return v
        apps = self.s_apps.get(sid) or ()
        rs = set(roles)
        C = self.C
        cand = [(cid, o) for (cid, rc, o) in apps if rc in rs and cid in C]
        if order in ("game", "bangumi"):
            cand.sort(key=lambda x: x[0])            # 和游戏一样：角色 id 从小到大（接口 /v0/subjects/{id}/characters 的顺序）
        else:
            cand.sort(key=lambda x: (-C[x[0]][C_HEAT], x[1], x[0]))
        v = [cid for cid, _ in cand]
        if len(self._pick_cache) > 200_000:
            self._pick_cache.clear()
        self._pick_cache[key] = v
        return v

    def best_work(self, cid: int) -> Optional[int]:
        """角色热度最高的、游戏算作登场的作品（S_COUNTS）；一部都没有就返回 None（= 这个角色没有登场作品）。"""
        best, best_key = None, None
        for sid, _rc in self.c_apps.get(cid) or ():
            s = self.S.get(sid)
            if not s or not s[S_COUNTS]:
                continue
            k = (s[S_HEAT], -sid)
            if best_key is None or k > best_key:
                best, best_key = sid, k
        return best

    # ---------------------------------------------------------- 模式画像
    def mode(self, mode: str, progress=None) -> ModeProfile:
        mp = self._modes.get(mode)
        if mp is not None:
            return mp
        with self._lock("mode:" + mode):
            mp = self._modes.get(mode)
            if mp is not None:
                return mp
            t0 = time.perf_counter()
            mp = ModeProfile(mode)
            if "profile" in self.tables:
                conn = self.connect()
                try:
                    if progress:
                        progress(f"读取{MODE_LABEL.get(mode, mode)}模式画像")
                    # 省内存：同样的标签字符串 / 年份 / 评分只留一份（每个模式上百万行，不去重要多占几百 MB）
                    strs, nums = self._strs, self._nums
                    for cid, fb, napp, e, l, r, cut, src in conn.execute(
                            "SELECT character_id, fallback, n_app, earliest, latest, rating, cut, source_tag FROM profile WHERE mode=?",
                            (mode,)):
                        vals = (int(fb or 0), int(napp or 0),
                                None if e is None or e < 0 else int(e),
                                None if l is None or l < 0 else int(l),
                                None if r is None or r < 0 else float(r),
                                -1 if cut is None else int(cut))
                        vals = tuple(v if v is None else nums.setdefault(v, v) for v in vals)
                        mp.prof[cid] = vals + (None if src is None else strs.setdefault(src, src),)
                    if progress:
                        progress(f"读取{MODE_LABEL.get(mode, mode)}模式作品标签")
                    tags: Dict[int, List[str]] = defaultdict(list)
                    universe: Dict[str, int] = defaultdict(int)
                    for cid, tag in conn.execute(
                            "SELECT character_id, tag FROM profile_tag WHERE mode=? ORDER BY character_id, rank", (mode,)):
                        tag = strs.setdefault(tag, tag)
                        tags[cid].append(tag)
                        universe[tag] += 1
                    mp.tags = {k: tuple(v) for k, v in tags.items()}
                    del tags
                    mp.tag_universe = dict(universe)
                    if "profile_app" in self.tables:
                        if progress:
                            progress(f"读取{MODE_LABEL.get(mode, mode)}模式登场作品")
                        apps: Dict[int, List[int]] = defaultdict(list)
                        cols = {r[1] for r in conn.execute("PRAGMA table_info(profile_app)")}
                        # extra=1：追加的 22 个特殊游戏，只用于「共同出演」，不算登场
                        where = " AND COALESCE(extra, 0) = 0" if "extra" in cols else ""
                        for cid, sid in conn.execute(
                                "SELECT character_id, subject_id FROM profile_app WHERE mode=?" + where +
                                " ORDER BY character_id, ord", (mode,)):
                            apps[cid].append(nums.setdefault(sid, sid))
                        mp.apps = {k: tuple(v) for k, v in apps.items()}
                finally:
                    conn.close()
            mp.load_ms = (time.perf_counter() - t0) * 1000
            self._modes[mode] = mp
            return mp

    def mode_loaded(self, mode: str) -> bool:
        return mode in self._modes

    def has_anime(self, cids: Iterable[int]) -> Dict[int, bool]:
        """角色有没有「游戏算的动画登场」：**动画模式**画像 fallback = 0 且 n_app > 0。和当前选的是哪个模式无关。
        动画模式已经读进内存就直接查内存；没读就用一条 SQL 只查这批 id（不为了这个去读整个动画模式，约 2 秒 + 170 MB）。"""
        ids = [int(c) for c in cids if c is not None]
        if not ids:
            return {}
        mp = self._modes.get("anime")
        if mp is not None:
            out: Dict[int, bool] = {}
            for c in ids:
                p = mp.prof.get(c)
                out[c] = bool(p) and not p[P_FALLBACK] and (p[P_NAPP] or 0) > 0
            return out
        out = {c: False for c in ids}
        if "profile" not in self.tables:
            return out
        uniq = sorted(set(ids))
        conn = self.connect()
        try:
            for i in range(0, len(uniq), 500):
                chunk = uniq[i:i + 500]
                sql = ("SELECT character_id FROM profile WHERE mode = 'anime' AND COALESCE(fallback, 0) = 0 "
                       "AND COALESCE(n_app, 0) > 0 AND character_id IN (" + ",".join("?" * len(chunk)) + ")")
                for (cid,) in conn.execute(sql, chunk):
                    out[int(cid)] = True
        finally:
            conn.close()
        return out

    # ---------------------------------------------------------- 角色标签 / 声优 / 外部标签
    def char_tags(self) -> Tuple[Dict[int, Tuple[str, ...]], Dict[str, FrozenSet[int]]]:
        def load():
            by_char: Dict[int, List[str]] = defaultdict(list)
            by_tag: Dict[str, Set[int]] = defaultdict(set)
            if "char_tag" in self.tables:
                conn = self.connect()
                try:
                    cols = {r[1] for r in conn.execute("PRAGMA table_info(char_tag)")}
                    order = " ORDER BY character_id, ord" if "ord" in cols else ""
                    for cid, tag in conn.execute("SELECT character_id, tag FROM char_tag" + order):
                        if tag is None:
                            continue
                        by_char[cid].append(tag)
                        by_tag[tag].add(cid)
                finally:
                    conn.close()
            return ({k: tuple(v) for k, v in by_char.items()}, {k: frozenset(v) for k, v in by_tag.items()})
        return self.lazy("char_tags", load)

    def va_cn(self) -> Dict[str, str]:
        """声优名（character_va.name，多是日文写法）-> person 表里的中文名（有的话）。给补全和按中文名匹配用。"""
        def load():
            out: Dict[str, str] = {}
            if "character_va" in self.tables and "person" in self.tables:
                conn = self.connect()
                try:
                    for name, cn in conn.execute(
                            "SELECT DISTINCT v.name, p.name_cn FROM character_va v JOIN person p ON p.name = v.name "
                            "WHERE p.name_cn IS NOT NULL AND p.name_cn <> ''"):
                        if name and cn and cn != name:
                            out[name] = cn
                finally:
                    conn.close()
            return out
        return self.lazy("va_cn", load)

    def va_fold(self) -> Dict[str, FrozenSet[int]]:
        """小写后的声优名（日文写法和中文名都收）-> 角色集合。"""
        def load():
            _, by_name = self.vas()
            cn = self.va_cn()
            acc: Dict[str, Set[int]] = defaultdict(set)
            for name, cids in by_name.items():
                acc[name.casefold()] |= cids
                if name in cn:
                    acc[cn[name].casefold()] |= cids
            return {k: frozenset(v) for k, v in acc.items()}
        return self.lazy("va_fold", load)

    def char_tag_counts(self) -> Dict[str, int]:
        return self.lazy("char_tag_counts", lambda: {k: len(v) for k, v in self.char_tags()[1].items()})

    def va_counts(self) -> Dict[str, int]:
        return self.lazy("va_counts", lambda: {k: len(v) for k, v in self.vas()[1].items()})

    def vas(self) -> Tuple[Dict[int, Tuple[str, ...]], Dict[str, FrozenSet[int]]]:
        def load():
            by_char: Dict[int, List[str]] = defaultdict(list)
            by_name: Dict[str, Set[int]] = defaultdict(set)
            if "character_va" in self.tables:
                conn = self.connect()
                try:
                    for cid, name in conn.execute("SELECT character_id, name FROM character_va ORDER BY character_id, ord"):
                        if not name:
                            continue
                        by_char[cid].append(name)
                        by_name[name].add(cid)
                finally:
                    conn.close()
            return ({k: tuple(v) for k, v in by_char.items()}, {k: frozenset(v) for k, v in by_name.items()})
        return self.lazy("vas", load)

    def ext_tags(self, cid: int) -> List[Dict[str, str]]:
        if "char_ext_tag" not in self.tables:
            return []
        conn = self.connect()
        try:
            return [{"category": c, "value": v} for c, v in conn.execute(
                "SELECT category, value FROM char_ext_tag WHERE character_id=?", (cid,))]
        finally:
            conn.close()

    # ---------------------------------------------------------- 作品本身的标签
    def work_tag_counts(self) -> Dict[str, int]:
        """标签名 -> 带这个标签的条目数（任意标注数；只算搜索可见的条目，和热度排名同一口径）。"""
        def load():
            out: Dict[str, int] = {}
            if "subject_tag" in self.tables:
                conn = self.connect()
                try:
                    for name, n in conn.execute(
                            "SELECT t.name, COUNT(*) FROM subject_tag t JOIN subject s ON s.id=t.subject_id "
                            f"WHERE {self.visible_sql} GROUP BY t.name"):
                        if name is not None:
                            out[name] = int(n)
                finally:
                    conn.close()
            return out
        return self.lazy("work_tag_counts", load)

    def work_tag_sets(self, tag: str) -> Tuple[FrozenSet[int], FrozenSet[int]]:
        """(任意标注数就算的条目集合, 标注数 ≥ 该条目最高标签 10% 的条目集合)。含 NSFW 条目（排名那边自己会排除）。"""
        v = self._work_tag_cache.get(tag)
        if v is not None:
            return v
        any_set: Set[int] = set()
        main_set: Set[int] = set()
        if "subject_tag" in self.tables:
            conn = self.connect()
            try:
                for sid, cnt, mx in conn.execute(
                        "SELECT t.subject_id, t.count, (SELECT MAX(c2.count) FROM subject_tag c2 WHERE c2.subject_id=t.subject_id) "
                        "FROM subject_tag t WHERE t.name=?", (tag,)):
                    any_set.add(sid)
                    if cnt is not None and mx is not None and cnt * 10 >= mx:
                        main_set.add(sid)
            finally:
                conn.close()
        v = (frozenset(any_set), frozenset(main_set))
        if len(self._work_tag_cache) > 2000:
            self._work_tag_cache.clear()
        self._work_tag_cache[tag] = v
        return v

    def meta_tag_counts(self) -> Dict[str, int]:
        """公共标签（subject_meta_tag）-> 搜索可见的条目数。没有这张表就是空。"""
        def load():
            out: Dict[str, int] = {}
            if "subject_meta_tag" in self.tables:
                conn = self.connect()
                try:
                    for name, n in conn.execute(
                            "SELECT t.tag, COUNT(*) FROM subject_meta_tag t JOIN subject s ON s.id=t.subject_id "
                            f"WHERE {self.visible_sql} GROUP BY t.tag"):
                        if name is not None:
                            out[name] = int(n)
                finally:
                    conn.close()
            return out
        return self.lazy("meta_tag_counts", load)

    def meta_tag_set(self, tag: str) -> FrozenSet[int]:
        key = "::meta::" + tag
        v = self._work_tag_cache.get(key)
        if v is not None:
            return v[0]
        out: Set[int] = set()
        if "subject_meta_tag" in self.tables:
            conn = self.connect()
            try:
                out = {r[0] for r in conn.execute("SELECT subject_id FROM subject_meta_tag WHERE tag=?", (tag,))}
            finally:
                conn.close()
        fs = frozenset(out)
        self._work_tag_cache[key] = (fs, fs)
        return fs

    def subject_tags(self, sid: int) -> List[Tuple[str, int]]:
        if "subject_tag" not in self.tables:
            return []
        conn = self.connect()
        try:
            return [(n, c) for n, c in conn.execute("SELECT name, count FROM subject_tag WHERE subject_id=? ORDER BY rank", (sid,))]
        finally:
            conn.close()

    # ---------------------------------------------------------- 搜索用的全名
    def char_search_names(self) -> Dict[int, str]:
        """cid -> 'display_name|name|name_cn'（小写），给搜索和清单按名字对号用。"""
        def load():
            out: Dict[int, str] = {}
            conn = self.connect()
            try:
                for cid, dn, n, ncn in conn.execute("SELECT id, display_name, name, name_cn FROM character"):
                    out[cid] = "|".join(x for x in (dn, n, ncn) if x).casefold()
            finally:
                conn.close()
            return out
        return self.lazy("char_search_names", load)

    def subject_search_names(self) -> Dict[int, str]:
        def load():
            out: Dict[int, str] = {}
            conn = self.connect()
            try:
                for sid, dn, n, ncn in conn.execute("SELECT id, display_name, name, name_cn FROM subject"):
                    if sid in self.S:
                        out[sid] = "|".join(x for x in (dn, n, ncn) if x).casefold()
            finally:
                conn.close()
            return out
        return self.lazy("subject_search_names", load)

    def subject_brief(self, sids: List[int]) -> Dict[int, Dict[str, Any]]:
        """不在 S 里的条目（没有角色）按需查名字。"""
        out: Dict[int, Dict[str, Any]] = {}
        missing = []
        for sid in sids:
            s = self.S.get(sid)
            if s:
                out[sid] = {"id": sid, "name": s[S_NAME], "type": s[S_TYPE], "year": s[S_YEAR], "heat": s[S_HEAT], "nsfw": bool(s[S_NSFW])}
            else:
                missing.append(sid)
        if missing:
            conn = self.connect()
            try:
                for i in range(0, len(missing), 500):
                    chunk = missing[i:i + 500]
                    q = "SELECT id, display_name, name, type, year, heat, nsfw FROM subject WHERE id IN (%s)" % ",".join("?" * len(chunk))
                    for sid, dn, n, t, y, h, ns in conn.execute(q, chunk):
                        out[sid] = {"id": sid, "name": dn or n, "type": t, "year": y, "heat": h, "nsfw": bool(ns)}
            finally:
                conn.close()
        return out

    def find_subjects_by_name(self, name: str) -> List[int]:
        """名字完全相同（display_name / name / name_cn，不分大小写）的条目，按热度降序；先找有角色的。"""
        key = name.strip().casefold()
        if not key:
            return []
        hits = [sid for sid, names in self.subject_search_names().items() if key in names.split("|")]
        hits.sort(key=lambda s: -self.S[s][S_HEAT])
        return hits

    def find_chars_by_name(self, name: str) -> List[int]:
        key = name.strip().casefold()
        if not key:
            return []
        hits = [cid for cid, names in self.char_search_names().items() if key in names.split("|")]
        hits.sort(key=lambda c: -self.C[c][C_HEAT] if c in self.C else 0)
        return hits


# ---------------------------------------------------------------- 快照管理
class DataHub:
    def __init__(self):
        self._snap: Optional[Snapshot] = None
        self._load_lock = threading.Lock()
        self._state: Dict[str, Any] = {"phase": "idle", "stage": None, "since": time.time(), "error": None}
        self._warm_thread: Optional[threading.Thread] = None
        # 新快照装好之后调用 hook(new_snapshot)；hook 必须很快返回（想干重活就自己起线程），出错不影响加载
        self.snapshot_hooks: List[Callable[["Snapshot"], None]] = []

    # 非阻塞：给 /v2/status
    def status(self) -> Dict[str, Any]:
        snap = self._snap
        st = dict(self._state)
        st["db_path"] = snap.path if snap else settings.resolve_db_path()
        st["candidates"] = settings.db_candidates()
        st["loaded_modes"] = sorted(snap._modes.keys()) if snap else []
        st["ready"] = snap is not None and st["phase"] in ("ready", "idle")
        if snap is not None:
            st["base_load_ms"] = round(snap.load_ms, 1)
            st["mode_load_ms"] = {m: round(mp.load_ms, 1) for m, mp in snap._modes.items()}
        return st

    def _set(self, phase: str, stage: Optional[str] = None, error: Optional[str] = None) -> None:
        self._state = {"phase": phase, "stage": stage, "since": time.time(), "error": error}

    def current(self) -> Snapshot:
        path = settings.resolve_db_path()
        if path is None:
            self._set("no_db", None, None)
            raise NoDatabase(settings.db_candidates())
        try:
            sig = file_sig(path)
        except FileNotFoundError:
            raise NoDatabase(settings.db_candidates())
        snap = self._snap
        if snap is not None and snap.sig == sig:
            return snap
        with self._load_lock:
            snap = self._snap
            try:
                sig = file_sig(path)
            except FileNotFoundError:
                raise NoDatabase(settings.db_candidates())
            if snap is not None and snap.sig == sig:
                return snap
            last_err = None
            for attempt in range(3):
                new = Snapshot(path, sig)
                self._set("loading", "读取基础数据")
                try:
                    new.load_base(progress=lambda s: self._set("loading", s))
                    old_modes = sorted(snap._modes.keys()) if snap is not None else []
                    self._snap = new
                    self._set("ready")
                    for hook in list(self.snapshot_hooks):
                        try:
                            hook(new)
                        except Exception:  # noqa: BLE001
                            pass
                    if old_modes:
                        # 换库了：把之前用过的模式在后台重新读好，下一个请求不用再等
                        self.warmup(modes=old_modes, tag_counts=[6])
                    return new
                except StaleSnapshot as e:
                    last_err = e
                    time.sleep(0.5)
                    sig = file_sig(path)
                except sqlite3.Error as e:
                    last_err = e
                    time.sleep(1.0)
                    try:
                        sig = file_sig(path)
                    except FileNotFoundError:
                        raise NoDatabase(settings.db_candidates())
            self._set("error", None, f"读库失败：{last_err}")
            raise RuntimeError(f"读库失败：{last_err}")

    def mode(self, snap: Snapshot, mode: str) -> ModeProfile:
        if snap.mode_loaded(mode):
            return snap.mode(mode)
        self._set("loading", f"读取{MODE_LABEL.get(mode, mode)}模式")
        try:
            mp = snap.mode(mode, progress=lambda s: self._set("loading", s))
        finally:
            self._set("ready")
        return mp

    def warmup(self, modes: List[str] = ("anime",), tag_counts: List[int] = (6,)) -> None:
        """后台预热：基础数据 + 用到的模式画像 + 默认 n 的倒排索引 + 补全用的索引。
        每次调用都起一个新线程（旧线程可能还在读已经被换掉的库）；同一样东西有锁，不会重复读。"""

        def run():
            try:
                snap = self.current()
                for m in modes:
                    mp = self.mode(snap, m)
                    for n in tag_counts:
                        mp.tag_index(n)
                # 其余懒加载的东西也顺手读好（补全、声优、作品标签），让第一次用的时候不卡
                for fn in (snap.char_tags, snap.vas, snap.va_cn, snap.va_fold, snap.char_tag_counts, snap.va_counts,
                           snap.work_tag_counts, snap.meta_tag_counts, snap.char_search_names, snap.subject_search_names):
                    fn()
            except (NoDatabase, StaleSnapshot):
                pass          # 没库 / 读到一半库又被换了：下一次请求会重新加载，不算错误
            except Exception as e:  # noqa: BLE001
                self._set("error", None, f"预热失败：{e}")

        self._warm_thread = threading.Thread(target=run, name="v2-warmup", daemon=True)
        self._warm_thread.start()


HUB = DataHub()


def with_snapshot(fn, retries: int = 2):
    """在当前快照上跑 fn(snap)；中途库被换掉（StaleSnapshot）就换新快照重跑。"""
    last = None
    for _ in range(retries + 1):
        snap = HUB.current()
        try:
            return fn(snap)
        except StaleSnapshot as e:
            last = e
            time.sleep(0.3)
    raise RuntimeError(f"数据库在读取过程中反复被替换，稍后再试（{last}）")
