# -*- coding: utf-8 -*-
"""SpecV2 求值引擎。

evaluate(spec) → EvalResult：每个范围 / 排除项的人数、每一步筛掉多少人、题库 = 并集 − 排除并集。
draw(ev, seed) → 抽题（三种方式，seed 可复现）。
build_item(ev, cid) → CandidateV2（字段和前端的 CandidateItem / DrawResult 对得上）。
compute_stats(ev) → 与前端的 StatsResp 同形。
"""
from __future__ import annotations

import difflib
import hashlib
import json
import random
import secrets
import time
from collections import Counter, OrderedDict, defaultdict
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from . import sqlsafe
from .sentence import condition_is_empty, range_sentence, tagfilter_is_empty
from .spec import RangeV2, SpecV2, TagFilter
from .storage import LISTS
from .store import (C_GENDER, C_HEAT, C_NAME, HUB, MODE_LABEL, P_CUT, P_EARLIEST, P_FALLBACK, P_LATEST, P_NAPP,
                    P_RATING, P_SOURCE, REL_CODE, S_COUNTS, S_HEAT, S_NAME, S_TYPE, S_YEAR, ModeProfile, Snapshot,
                    TagIndex, with_snapshot)

PLAYBACK = ["TV", "剧场版", "OVA", "WEB", "动态漫画"]
SOURCE_CANON = ["原创", "漫画改", "小说改", "游戏改"]
GENDER_SYMBOL = {"男": "♂", "女": "♀", None: "?"}
NUM_FIELD = {"n_app": P_NAPP, "earliest_year": P_EARLIEST, "latest_year": P_LATEST, "rating": P_RATING}


# ---------------------------------------------------------------- 标签相近提示
def closest_names(name: str, universe: Dict[str, int], limit: int = 5) -> List[str]:
    if not universe:
        return []
    key = name.strip()
    contains = [k for k in universe if k != key and (key in k or (len(k) >= 2 and k in key))]
    contains.sort(key=lambda k: (-universe.get(k, 0), len(k)))
    out = contains[:limit]
    if len(out) < limit:
        close = difflib.get_close_matches(key, list(universe.keys()), n=limit * 2, cutoff=0.5)
        for k in close:
            if k not in out and k != key:
                out.append(k)
            if len(out) >= limit:
                break
    return out[:limit]


# ---------------------------------------------------------------- 求值上下文
class Ctx:
    def __init__(self, snap: Snapshot, mp: ModeProfile, ti: TagIndex, spec: SpecV2):
        self.snap = snap
        self.mp = mp
        self.ti = ti
        self.spec = spec
        self.mode = spec.game.mode
        self.n = spec.game.tag_count
        self.warnings: List[str] = []
        self._lists: Dict[str, Optional[Dict[str, Any]]] = {}

    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)

    def lists_get(self, list_id: str) -> Optional[Dict[str, Any]]:
        if list_id not in self._lists:
            self._lists[list_id] = LISTS.get(list_id) if list_id else None
        return self._lists[list_id]

    def get_list(self, list_id: Optional[str], kind: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        zh = {"character": "角色清单", "work": "作品清单", "tag": "标签清单"}[kind]
        if not list_id:
            return None, f"没选{zh}"
        d = self.lists_get(list_id)
        if d is None:
            return None, f"{zh}「{list_id}」不存在（可能被删了）"
        if d.get("kind") != kind:
            return None, f"清单『{d.get('name')}』是{ {'character': '角色清单', 'work': '作品清单', 'tag': '标签清单'}.get(d.get('kind'), '未知种类清单')}，这里要的是{zh}"
        return d, None

    # 标签：显式标签 + 标签清单展开，去重保序
    def expand_tags(self, tf: TagFilter) -> List[str]:
        names: List[str] = []
        seen: Set[str] = set()
        if tf.tag_list_id:
            d, err = self.get_list(tf.tag_list_id, "tag")
            if err:
                # 清单没了，标签就一个也取不到：「含全部 / 都不含」会变成人人满足、作品标签筛选会整条失效。
                # 所以和角色清单、作品清单一样算错误（进 evaluate 的 errors，抽题会被拒）。
                raise CondError(err)
            else:
                for it in d.get("items") or ():
                    nm = str(it.get("name") or "").strip()
                    if nm and nm not in seen:
                        seen.add(nm)
                        names.append(nm)
        for t in tf.tags or ():
            if t not in seen:
                seen.add(t)
                names.append(t)
        return names

    def warn_missing(self, missing: List[str], universe_fn: Callable[[], Dict[str, int]], what: str) -> None:
        """库里没有的标签给一条提示（最接近的几个）。只有真有缺的时候才去拿完整标签表。"""
        if not missing:
            return
        universe = universe_fn()
        for t in missing:
            near = closest_names(t, universe)
            if near:
                self.warn(f"{what}『{t}』在库里不存在，最接近：{'、'.join(near)}")
            else:
                self.warn(f"{what}『{t}』在库里不存在，也没有相近的")

    def tag_names(self, tf: TagFilter, universe: Dict[str, int], what: str) -> List[str]:
        names = self.expand_tags(tf)
        self.warn_missing([t for t in names if t not in universe], lambda: universe, what)
        return names

    def resolve_char_items(self, d: Dict[str, Any]) -> List[int]:
        out: List[int] = []
        missing = 0
        for it in d.get("items") or ():
            cid = it.get("id")
            if cid is None and it.get("name"):
                hits = self.snap.find_chars_by_name(it["name"])
                if len(hits) >= 1:
                    cid = hits[0]
                    if len(hits) > 1:
                        self.warn(f"角色清单『{d.get('name')}』里的「{it['name']}」有 {len(hits)} 个同名角色，按热度最高的算")
            if cid is None:
                missing += 1
                continue
            out.append(int(cid))
        if missing:
            self.warn(f"角色清单『{d.get('name')}』里有 {missing} 项对不上库里的角色")
        return out

    def resolve_work_items(self, d: Dict[str, Any]) -> List[int]:
        out: List[int] = []
        missing = 0
        for it in d.get("items") or ():
            sid = it.get("id")
            if sid is None and it.get("name"):
                hits = self.snap.find_subjects_by_name(it["name"])
                if hits:
                    sid = hits[0]
                    if len(hits) > 1:
                        self.warn(f"作品清单『{d.get('name')}』里的「{it['name']}」有 {len(hits)} 部同名作品，按热度最高的算")
            if sid is None:
                missing += 1
                continue
            out.append(int(sid))
        if missing:
            self.warn(f"作品清单『{d.get('name')}』里有 {missing} 项对不上库里的作品")
        return out


# ---------------------------------------------------------------- 标签量词
def tag_match(members: Set[int], names: List[str], quant: str, k: Optional[int],
              by_tag: Callable[[str], FrozenSet[int]]) -> Set[int]:
    """在 members 里找满足「含任一 / 含全部 / 至少含 k 个 / 都不含」的。"""
    if quant == "any":
        out: Set[int] = set()
        for t in names:
            s = by_tag(t)
            if s:
                out |= (s & members) if len(s) > len(members) else {c for c in s if c in members}
        return out
    if quant == "none":
        hit: Set[int] = set()
        for t in names:
            s = by_tag(t)
            if s:
                hit |= s & members
        return members - hit
    if quant == "all":
        out = set(members)
        for t in names:
            out &= by_tag(t)
            if not out:
                break
        return out
    # at_least
    kk = 1 if k is None else int(k)
    if kk <= 0:
        return set(members)
    if kk > len(names):
        return set()
    cnt: Counter = Counter()
    for t in names:
        s = by_tag(t)
        if s:
            cnt.update(s & members)
    return {c for c, v in cnt.items() if v >= kk}


def work_tag_pred(ctx: Ctx, tf: TagFilter) -> Callable[[int], bool]:
    """作品本身的标签 → 对条目 id 的判断函数。"""
    snap = ctx.snap
    names = ctx.expand_tags(tf)
    if tf.tag_mode == "meta":
        sets = [snap.meta_tag_set(t) for t in names]
        ctx.warn_missing([t for t, st in zip(names, sets) if not st], snap.meta_tag_counts, "公共标签")
    else:
        idx = 1 if tf.tag_mode != "any" else 0
        both = [snap.work_tag_sets(t) for t in names]
        sets = [x[idx] for x in both]
        ctx.warn_missing([t for t, x in zip(names, both) if not x[0]], snap.work_tag_counts, "作品标签")
    q = tf.quant
    if not names:
        return lambda sid: True
    if q == "any":
        u = frozenset().union(*sets)
        return u.__contains__
    if q == "none":
        u = frozenset().union(*sets)
        return lambda sid: sid not in u
    if q == "all":
        inter = frozenset(sets[0]).intersection(*sets[1:]) if sets else frozenset()
        return inter.__contains__
    kk = 1 if tf.k is None else int(tf.k)
    if kk <= 0:
        return lambda sid: True
    cnt: Counter = Counter()
    for s in sets:
        cnt.update(s)
    ok = frozenset(sid for sid, v in cnt.items() if v >= kk)
    return ok.__contains__


# ---------------------------------------------------------------- 来源 + 取角色
class RangeEval:
    __slots__ = ("id", "enabled", "label", "share", "sentence", "works", "picked", "steps", "final", "bind",
                 "error", "all_chars", "kind")

    def __init__(self, r: RangeV2, sentence: str):
        self.id = r.id
        self.enabled = r.enabled
        self.label = r.label
        self.share = r.share
        self.kind = r.source.kind
        self.sentence = sentence
        self.works: Optional[int] = None
        self.picked = 0
        self.steps: List[Dict[str, Any]] = []
        self.final: Set[int] = set()
        self.bind: Dict[int, Set[int]] = {}
        self.error: Optional[str] = None
        self.all_chars = False


def _pick_from_works(ctx: Ctx, sids: Iterable[int], pick) -> Tuple[Set[int], Dict[int, Set[int]]]:
    roles = tuple(sorted(REL_CODE[x] for x in pick.roles))
    per = pick.per_work
    members: Set[int] = set()
    bind: Dict[int, Set[int]] = defaultdict(set)
    snap = ctx.snap
    s_apps = snap.s_apps
    for sid in sids:
        if sid not in s_apps:          # 大多数条目（尤其书籍）没有角色：直接跳过，不进 picked()
            continue
        cids = snap.picked(sid, roles, pick.order)
        if per:
            cids = cids[:per]
        for cid in cids:
            members.add(cid)
            bind[cid].add(sid)
    return members, dict(bind)


def eval_source(ctx: Ctx, r: RangeV2, re_: RangeEval) -> Set[int]:
    src = r.source
    snap = ctx.snap
    if src.kind == "rank":
        keep = None
        if not tagfilter_is_empty(src.work_filter):
            try:
                keep = work_tag_pred(ctx, src.work_filter)
            except CondError as e:
                re_.error = "作品本身的标签：" + str(e)
                re_.works = 0
                return set()
        after = keep is not None and src.work_filter_order == "after_rank"
        ranked = snap.ranked(src.subject_types, src.year_from, src.year_to, src.include_unaired,
                             None if after else keep)
        a = src.rank_from - 1
        b = src.rank_to
        if src.rank_scope == "per_year" and not (b is None and a == 0):
            by_year: Dict[int, List[int]] = defaultdict(list)
            for sid, y in ranked:
                if y is not None:
                    by_year[y].append(sid)
            sel: List[int] = []
            for y in sorted(by_year):
                sel.extend(by_year[y][a:b])
        else:
            sel = [sid for sid, _ in ranked[a:b]]
        if after:
            sel = [sid for sid in sel if keep(sid)]      # 先排名、再按作品本身的标签筛（after_rank 的语义，可选）
        re_.works = len(sel)
        members, re_.bind = _pick_from_works(ctx, sel, r.pick)
        return members
    if src.kind == "work_list":
        d, err = ctx.get_list(src.list_id, "work")
        if err:
            re_.error = err
            re_.works = 0
            return set()
        sids = list(dict.fromkeys(ctx.resolve_work_items(d)))
        re_.works = len(sids)
        members, re_.bind = _pick_from_works(ctx, sids, r.pick)
        return members
    if src.kind == "char_list":
        d, err = ctx.get_list(src.list_id, "character")
        if err:
            re_.error = err
            return set()
        ids = ctx.resolve_char_items(d)
        members = {c for c in ids if c in snap.C}
        if len(members) < len(set(ids)):
            ctx.warn(f"角色清单『{d.get('name')}』里有 {len(set(ids)) - len(members)} 个角色不在角色库里（没当过主角或配角）")
        return members
    # all_characters
    re_.all_chars = True
    return set(snap.C.keys())


# ---------------------------------------------------------------- 条件
def cond_match(ctx: Ctx, c, members: Set[int]) -> Set[int]:
    """返回 members 里满足条件（不考虑取反）的那部分。"""
    snap, mp = ctx.snap, ctx.mp
    C = snap.C
    t = c.type
    if t == "gender":
        want = {None if v == "未知" else v for v in c.values}
        return {cid for cid in members if C[cid][C_GENDER] in want}
    if t == "char_heat":
        lo = c.min if c.min is not None else float("-inf")
        hi = c.max if c.max is not None else float("inf")
        return {cid for cid in members if lo <= C[cid][C_HEAT] <= hi}
    if t in NUM_FIELD:
        f = NUM_FIELD[t]
        lo = c.min if c.min is not None else float("-inf")
        hi = c.max if c.max is not None else float("inf")
        prof = mp.prof
        out = set()
        for cid in members:
            p = prof.get(cid)
            if not p or not p[P_NAPP]:
                continue
            v = p[f]
            if v is not None and lo <= v <= hi:
                out.add(cid)
        return out
    if t == "game_tags":
        names = ctx.tag_names(c, ctx.mp.tag_universe, "作品标签")
        by_tag = ctx.ti.by_tag
        return tag_match(members, names, c.quant, c.k, lambda x: by_tag.get(x, frozenset()))
    if t == "char_tags":
        by_char, by_tag = snap.char_tags()
        names = ctx.tag_names(c, snap.char_tag_counts(), "角色标签")
        return tag_match(members, names, c.quant, c.k, lambda x: by_tag.get(x, frozenset()))
    if t == "va":
        fold = snap.va_fold()
        hit: Set[int] = set()
        for nm in c.names:
            key = nm.strip().casefold()
            if not key:
                continue
            s = fold.get(key)
            if s is None:
                near = closest_names(nm.strip(), snap.va_counts(), 3)
                ctx.warn(f"声优『{nm.strip()}』在库里不存在" + (f"，最接近：{'、'.join(near)}" if near else ""))
                continue
            hit |= s
        return members & hit
    if t == "source_tag":
        vals = set(c.values)
        for v in vals:
            if v not in SOURCE_CANON:
                ctx.warn(f"来源『{v}』不是常见取值（原创 / 漫画改 / 小说改 / 游戏改）")
        prof = mp.prof
        out = set()
        for cid in members:
            p = prof.get(cid)
            if p and p[P_NAPP] and p[P_SOURCE] in vals:
                out.add(cid)
        return out
    if t == "appearance":
        return appearance_match(ctx, c, members)
    if t == "char_list":
        d, err = ctx.get_list(c.list_id, "character")
        if err:
            raise CondError(err)
        ids = set(ctx.resolve_char_items(d))
        return members & ids
    if t == "sql":
        ids, n_rows, n_bad = sql_condition_ids(snap, c.sql)
        if n_rows and n_bad == n_rows:
            raise CondError("自定义查询的第一列不是角色 id（第一列要是 character_id 这样的整数）")
        if n_bad:
            ctx.warn(f"自定义查询有 {n_bad:,} 行的第一列不是整数，这些行没算进去（第一列要是 character_id）")
        return members & ids
    raise CondError(f"不认识的条件类型 {t}")


class CondError(Exception):
    pass


def appearance_match(ctx: Ctx, c, members: Set[int]) -> Set[int]:
    snap = ctx.snap
    S = snap.S
    types = set(c.subject_types) if c.subject_types else None
    yf, yt = c.year_from, c.year_to
    need_year = yf is not None or yt is not None
    roles = {REL_CODE[r] for r in c.roles} if c.roles else None
    tag_ok = None if tagfilter_is_empty(c.work_tags) else work_tag_pred(ctx, c.work_tags)
    in_list: Optional[Set[int]] = None
    if c.work_list_id:
        d, err = ctx.get_list(c.work_list_id, "work")
        if err:
            raise CondError(err)
        in_list = set(ctx.resolve_work_items(d))
    memo: Dict[int, bool] = {}

    def subj_ok(sid: int) -> bool:
        v = memo.get(sid)
        if v is not None:
            return v
        s = S.get(sid)
        ok = s is not None and bool(s[S_COUNTS])        # 游戏算不算这部登场：anon_detail = 1 且不是 locked
        if ok and types is not None and s[S_TYPE] not in types:
            ok = False
        if ok and need_year:
            y = s[S_YEAR]
            ok = y is not None and (yf is None or y >= yf) and (yt is None or y <= yt)
        if ok and in_list is not None and sid not in in_list:
            ok = False
        if ok and tag_ok is not None and not tag_ok(sid):
            ok = False
        memo[sid] = ok
        return ok

    out = set()
    c_apps = snap.c_apps
    for cid in members:
        for sid, rc in c_apps.get(cid, ()):
            if (roles is None or rc in roles) and subj_ok(sid):
                out.add(cid)
                break
    return out


def sql_condition_ids(snap: Snapshot, sql: str) -> Tuple[FrozenSet[int], int, int]:
    """返回 (角色 id 集合, 总行数, 第一列不是整数的行数)。"""
    key = "sqlcond:" + hashlib.sha1(sql.encode("utf-8")).hexdigest() + ":" + str(LISTS.version())
    hit = snap.cache.get(key)
    if hit is not None:
        return hit
    conn = snap.connect()
    try:
        ids, n_rows, n_bad = sqlsafe.run_ids_checked(conn, sql, lists=LISTS.all())
    except sqlsafe.SqlError as e:
        raise CondError("自定义查询出错：" + e.message)
    finally:
        conn.close()
    res = (frozenset(ids), n_rows, n_bad)
    snap.cache_put(key, res)
    return res


def eval_range(ctx: Ctx, r: RangeV2) -> RangeEval:
    re_ = RangeEval(r, range_sentence(r, ctx.lists_get))
    members = eval_source(ctx, r, re_)
    re_.picked = len(members)
    for c in r.conditions:
        before = len(members)
        step: Dict[str, Any] = {"condition_id": c.id, "before": before, "after": before, "removed": 0,
                                "skipped": None, "error": None}
        if not c.enabled:
            step["skipped"] = "disabled"
            re_.steps.append(step)
            continue
        if condition_is_empty(c):
            step["skipped"] = "empty"
            ctx.warn("有一个条件还没填内容，先跳过了（不影响人数）")
            re_.steps.append(step)
            continue
        try:
            m = cond_match(ctx, c, members)
            members = (members - m) if c.negate else m
        except CondError as e:
            step["skipped"] = "error"
            step["error"] = str(e)
            re_.error = re_.error or str(e)
        step["after"] = len(members)
        step["removed"] = before - len(members)
        re_.steps.append(step)
    re_.final = members
    return re_


# ---------------------------------------------------------------- 求值结果
class EvalResult:
    def __init__(self, spec: SpecV2, snap: Snapshot, mp: ModeProfile, ti: TagIndex):
        self.spec = spec
        self.snap = snap
        self.mp = mp
        self.ti = ti
        self.ranges: List[RangeEval] = []
        self.excludes: List[RangeEval] = []
        self.pool: Set[int] = set()
        self.union: Set[int] = set()
        self.excluded: Set[int] = set()
        self.warnings: List[str] = []
        self.errors: List[Dict[str, Any]] = []     # 启用中的范围 / 排除项出错（清单被删、SQL 出错……）
        self.empty_grid = 0                          # 题库里当前模式下登场数为 0（游戏格子为空）的人数
        self.elapsed_ms = 0.0
        self._pool_sorted: Optional[List[int]] = None
        self._in_ranges: Optional[Dict[int, List[str]]] = None

    @property
    def pool_sorted(self) -> List[int]:
        if self._pool_sorted is None:
            self._pool_sorted = sorted(self.pool)
        return self._pool_sorted

    def in_ranges(self, cid: int) -> List[str]:
        return [r.id for r in self.ranges if r.enabled and cid in r.final]

    def bound_works(self, cid: int) -> List[int]:
        ws: Set[int] = set()
        for r in self.ranges:
            if r.enabled and cid in r.final:
                b = r.bind.get(cid)
                if b:
                    ws |= b
        return sorted(ws)

    def best_bound_work(self, cid: int) -> Optional[int]:
        ws = self.bound_works(cid)
        S = self.snap.S
        if ws:
            return max(ws, key=lambda s: (S[s][S_HEAT] if s in S else -1, -s))
        return self.snap.best_work(cid)

    def to_response(self, elapsed_ms: Optional[float] = None, cached: bool = False) -> Dict[str, Any]:
        enabled = [r for r in self.ranges if r.enabled]
        ranges_out = []
        for r in self.ranges:
            if r.enabled:
                other: Set[int] = set()
                for o in enabled:
                    if o is not r:
                        other |= o.final
                unique = len((r.final & self.pool) - other)
            else:
                unique = 0
            ranges_out.append({
                "id": r.id, "sentence": r.sentence, "works": r.works, "picked": r.picked, "steps": r.steps,
                "final": len(r.final), "unique": unique, "error": r.error,
                "enabled": r.enabled, "in_pool": len(r.final & self.pool) if r.enabled else 0,
            })
        ex_out = []
        for e in self.excludes:
            ex_out.append({
                "id": e.id, "sentence": e.sentence, "matched": len(e.final),
                "removed_from_pool": len(e.final & self.union) if e.enabled else 0,
                "error": e.error, "enabled": e.enabled, "steps": e.steps, "works": e.works, "picked": e.picked,
            })
        return {"total": len(self.pool), "ranges": ranges_out, "excludes": ex_out, "warnings": self.warnings,
                "errors": self.errors, "empty_grid": self.empty_grid,
                "elapsed_ms": round(self.elapsed_ms if elapsed_ms is None else elapsed_ms, 1), "cached": cached,
                "compute_ms": round(self.elapsed_ms, 1),
                "mode": self.spec.game.mode, "tag_count": self.spec.game.tag_count}


def _cache_key(spec: SpecV2) -> str:
    d = spec.model_dump(mode="json", include={"game", "ranges", "excludes"})
    raw = json.dumps(d, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1((raw + "|" + str(LISTS.version())).encode("utf-8")).hexdigest()


def evaluate(spec: SpecV2, use_cache: bool = True) -> EvalResult:
    def run(snap: Snapshot) -> EvalResult:
        t0 = time.perf_counter()
        key = "eval:" + _cache_key(spec)
        if use_cache:
            with snap.cache_lock:
                hit = snap.cache.get(key)
                if hit is not None:
                    snap.cache.move_to_end(key)
            if hit is not None:
                return hit
        mp = HUB.mode(snap, spec.game.mode)
        ti = mp.tag_index(spec.game.tag_count)
        ctx = Ctx(snap, mp, ti, spec)
        ev = EvalResult(spec, snap, mp, ti)
        if not mp.prof:
            ctx.warn(f"库里还没有「{MODE_LABEL.get(spec.game.mode, spec.game.mode)}」模式的角色画像，作品标签 / 登场数等条件都按空算")
        ev.ranges = [eval_range(ctx, r) for r in spec.ranges]
        ev.excludes = [eval_range(ctx, r) for r in spec.excludes]
        union: Set[int] = set()
        for r in ev.ranges:
            if r.enabled:
                union |= r.final
        excluded: Set[int] = set()
        for e in ev.excludes:
            if e.enabled:
                excluded |= e.final
        ev.union = union
        ev.excluded = excluded
        ev.pool = union - excluded
        if not any(r.enabled for r in ev.ranges):
            ctx.warn("没有启用的范围，题库是空的")
        for kind, items in (("范围", ev.ranges), ("排除", ev.excludes)):
            for i, r in enumerate(items):
                if r.enabled and r.error:
                    ev.errors.append({"where": "range" if kind == "范围" else "exclude", "id": r.id,
                                      "index": i, "message": f"{kind} {i + 1}：{r.error}"})
        for e in ev.errors:
            ctx.warn(e["message"] + "（这一项没有按你的意思生效，先修好再抽题）")
        prof = mp.prof
        n_empty = 0
        for cid in ev.pool:
            p = prof.get(cid)
            if not p or not p[P_NAPP]:
                n_empty += 1
        ev.empty_grid = n_empty
        if n_empty:
            ctx.warn(f"题库里有 {n_empty:,} 人在当前模式下游戏格子为空（登场数 0），抽到会出没意义的题")
        ev.warnings = ctx.warnings
        ev.elapsed_ms = (time.perf_counter() - t0) * 1000
        snap.cache_put(key, ev)
        return ev

    return with_snapshot(run)


# ---------------------------------------------------------------- 抽题
def new_seed() -> int:
    return secrets.randbits(31)


def draw(ev: EvalResult, seed: Optional[int], method: str) -> Tuple[Optional[int], Optional[str], Optional[int], int]:
    """返回 (角色 id, 从哪个范围抽的, 绑定作品, 实际用的 seed)。题库空时角色 id 为 None。

    method 必须由调用方从**这次请求的方案**里传进来：求值结果有缓存，缓存的 key 不含抽题设置，
    ev.spec.draw 可能是别的请求留下的。"""
    if method not in ("per_character", "per_work", "range_share"):
        raise ValueError(f"不认识的抽题方式 {method}")
    if seed is None:
        seed = new_seed()
    rng = random.Random(int(seed))
    pool = ev.pool_sorted
    if not pool:
        return None, None, None, seed
    if method == "per_work":
        groups: Dict[Any, List[int]] = defaultdict(list)
        for cid in pool:
            ws = ev.bound_works(cid)
            if not ws:
                w = ev.snap.best_work(cid)
                ws = [w] if w is not None else []
            if not ws:
                groups[("c", cid)].append(cid)
            for w in ws:
                groups[("w", w)].append(cid)
        keys = sorted(groups.keys(), key=lambda k: (k[0], k[1]))
        gk = keys[rng.randrange(len(keys))]
        members = groups[gk]
        cid = members[rng.randrange(len(members))]
        work = gk[1] if gk[0] == "w" else None
        rid = next((r.id for r in ev.ranges if r.enabled and cid in r.final), None)
        return cid, rid, work, seed
    if method == "range_share":
        eff = []
        for r in ev.ranges:
            if not r.enabled:
                continue
            members = sorted(r.final - ev.excluded)
            if not members:
                continue
            w = 1.0 if r.share is None else float(r.share)
            eff.append((r, members, max(0.0, w)))
        if not eff:
            return None, None, None, seed
        total_w = sum(w for _, _, w in eff)
        if total_w <= 0:
            eff = [(r, m, 1.0) for r, m, _ in eff]
            total_w = float(len(eff))
        x = rng.random() * total_w
        acc = 0.0
        chosen = eff[-1]
        for item in eff:
            acc += item[2]
            if x < acc:
                chosen = item
                break
        r, members, _ = chosen
        cid = members[rng.randrange(len(members))]
        b = r.bind.get(cid)
        S = ev.snap.S
        work = max(b, key=lambda s: (S[s][S_HEAT] if s in S else -1, -s)) if b else ev.snap.best_work(cid)
        return cid, r.id, work, seed
    # per_character
    cid = pool[rng.randrange(len(pool))]
    rid = next((r.id for r in ev.ranges if r.enabled and cid in r.final), None)
    return cid, rid, ev.best_bound_work(cid), seed


# ---------------------------------------------------------------- 候选条目
def grid_of(snap: Snapshot, mp: ModeProfile, ti: TagIndex, cid: int) -> Dict[str, Any]:
    p = mp.prof.get(cid)
    has = bool(p) and bool(p[P_NAPP])
    return {
        "mode": mp.mode, "n": ti.n,
        "tags": list(ti.by_char.get(cid, ())),
        "n_app": p[P_NAPP] if has else 0,
        "earliest": p[P_EARLIEST] if has else None,
        "latest": p[P_LATEST] if has else None,
        "rating": p[P_RATING] if has else None,
        "source_tag": p[P_SOURCE] if has else None,
        "fallback": bool(p[P_FALLBACK]) if p else False,
    }


def _work_ref(snap: Snapshot, sid: Optional[int]) -> Optional[Dict[str, Any]]:
    if sid is None:
        return None
    s = snap.S.get(sid)
    if s is None:
        b = snap.subject_brief([sid]).get(sid)
        if not b:
            return {"id": sid, "name": str(sid), "year": None}
        return {"id": sid, "name": b["name"], "year": b["year"]}
    return {"id": sid, "name": s[S_NAME], "year": s[S_YEAR]}


def build_item(ev: EvalResult, cid: int, bound_sid: Optional[int] = None, use_bound: bool = False) -> Dict[str, Any]:
    snap, mp, ti = ev.snap, ev.mp, ev.ti
    c = snap.C.get(cid) or (str(cid), None, 0)
    grid = grid_of(snap, mp, ti, cid)
    ctags = list(snap.char_tags()[0].get(cid, ()))
    vas = list(snap.vas()[0].get(cid, ()))
    if not use_bound:
        bound_sid = ev.best_bound_work(cid)
    bw = _work_ref(snap, bound_sid)
    app_sids = list(mp.apps.get(cid, ()))[:10]
    names = []
    missing = [s for s in app_sids if s not in snap.S]
    extra = snap.subject_brief(missing) if missing else {}
    for s in app_sids:
        if s in snap.S:
            names.append(snap.S[s][S_NAME])
        elif s in extra:
            names.append(extra[s]["name"])
    heat_bw = snap.S[bound_sid][S_HEAT] if (bound_sid is not None and bound_sid in snap.S) else 0
    return {
        "char_id": cid,
        "character": {
            "id": cid, "name": c[C_NAME], "gender": GENDER_SYMBOL.get(c[C_GENDER], "?"), "heat": c[C_HEAT],
            "max_score": grid["rating"], "earliest_year": grid["earliest"], "latest_year": grid["latest"],
        },
        "mode": "char-weight",
        "weight": 1,
        "bound_work": bw,
        "bound_work_id": bw["id"] if bw else None,
        "appearances": names,
        "work_tags": grid["tags"],
        "char_tags": ctags,
        "source_tag": grid["source_tag"],
        "grid": grid,
        "vas": vas,
        "ranges": ev.in_ranges(cid),
        # DrawResult 的字段（「当前题目」卡片用）
        "appear_count": grid["n_app"],
        "work_count": grid["n_app"],
        "appear_best": ({"id": bw["id"], "name": bw["name"], "year": bw["year"], "favorites": heat_bw} if bw else None),
        "playback_tags": [t for t in PLAYBACK if t in set(grid["tags"])],
    }


def empty_draw(seed: int, pool_total: int = 0) -> Dict[str, Any]:
    return {"char_id": None, "character": None, "mode": "char-weight", "weight": 1, "bound_work": None,
            "bound_work_id": None, "appearances": [], "work_tags": [], "char_tags": [], "source_tag": None,
            "grid": None, "vas": [], "ranges": [], "range_id": None, "pool_total": pool_total, "seed": seed}


# ---------------------------------------------------------------- 候选列表
def candidate_ids(ev: EvalResult, sort: str = "heat", q: Optional[str] = None, seed: int = 0) -> List[int]:
    snap = ev.snap
    C = snap.C
    ids = list(ev.pool)
    if q and q.strip():
        key = q.strip().casefold()
        names = snap.char_search_names()
        S = snap.S

        def hit(cid: int) -> bool:
            if key in (names.get(cid) or C[cid][C_NAME].casefold()):
                return True
            w = ev.best_bound_work(cid)
            return bool(w is not None and w in S and key in S[w][S_NAME].casefold())

        ids = [cid for cid in ids if hit(cid)]
    if sort == "name":
        ids.sort(key=lambda c: (C[c][C_NAME].casefold(), c))
    elif sort == "random":
        ids.sort()
        random.Random(int(seed or 0)).shuffle(ids)
    else:
        ids.sort(key=lambda c: (-C[c][C_HEAT], c))
    return ids


# ---------------------------------------------------------------- 统计（与前端的 StatsResp 同形）
def compute_stats(ev: EvalResult) -> Dict[str, Any]:
    t0 = time.perf_counter()
    snap, mp, ti = ev.snap, ev.mp, ev.ti
    by_year: Counter = Counter()
    by_gender: Counter = Counter()
    work_tags: Counter = Counter()
    char_tags: Counter = Counter()
    playback: Counter = Counter()
    source: Counter = Counter()
    no_year = 0
    score_sum, score_n = 0.0, 0
    ctag_by_char = snap.char_tags()[0]
    pb = set(PLAYBACK)
    src_set = set(SOURCE_CANON)
    for cid in ev.pool:
        c = snap.C.get(cid)
        if not c:
            continue
        p = mp.prof.get(cid)
        has = bool(p) and bool(p[P_NAPP])
        ey = p[P_EARLIEST] if has else None
        if ey is None:
            no_year += 1
        else:
            by_year[int(ey)] += 1
        by_gender[GENDER_SYMBOL.get(c[C_GENDER], "?")] += 1
        r = p[P_RATING] if has else None
        if r is not None and r > 0:
            score_sum += r
            score_n += 1
        for t in ti.by_char.get(cid, ()):
            if t in pb:
                playback[t] += 1
            elif t in src_set or (len(t) == 4 and t.isdigit()):
                continue
            else:
                work_tags[t] += 1
        if has and p[P_SOURCE]:
            source[p[P_SOURCE]] += 1
        for t in ctag_by_char.get(cid, ()):
            char_tags[t] += 1
    years = sorted(by_year)
    by_year_list = [{"year": y, "count": by_year.get(y, 0)} for y in range(years[0], years[-1] + 1)] if years else []
    return {
        "total": len(ev.pool),
        "by_year": by_year_list,
        "by_gender": {"♀": by_gender.get("♀", 0), "♂": by_gender.get("♂", 0), "?": by_gender.get("?", 0)},
        "top_work_tags": [{"tag": t, "count": n} for t, n in work_tags.most_common(30)],
        "top_char_tags": [{"tag": t, "count": n} for t, n in char_tags.most_common(30)],
        "playback": {k: playback.get(k, 0) for k in PLAYBACK},
        "source": {k: n for k, n in source.most_common()},
        "year_min": years[0] if years else None,
        "year_max": years[-1] if years else None,
        "avg_score": round(score_sum / score_n, 2) if score_n else None,
        "no_year": no_year,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
        "mode": mp.mode, "tag_count": ti.n,
    }
