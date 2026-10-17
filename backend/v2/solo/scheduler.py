"""单人猜猜呗：出题调度（只用 Python 标准库，不碰库、不碰磁盘）。

`progress()` 除了总进度，还返回 `parts`（每段对总进度的贡献百分比，给进度条画三段颜色）。
`Params.leech_fails` 默认 0（不停放：难记的角色照常出现）；传 leech_fails=3，连续 3 次 Again 后先停放。

状态是普通 dict，可以直接 json.dumps / json.loads，没有 set、没有 Infinity。
角色用字符串 key 表示。单人模式（见 session.py）用 key = f"char:{char_id}"，
「模式 + 练法」已经体现在存档文件名里（sched_<mode>_<practice>.json）。

接法：

    sch = Scheduler.new(pool_keys, groups)        # 或 Scheduler.from_json(saved) 再 set_pool(...)
    key = sch.start_next(now)                     # 开一局，返回答案角色
    sch.finish(grade, now)                        # 一局结束；grade ∈ again / hard / good / easy
    sch.regrade(key, new_grade)                   # 改上一局评分（下一局已经开始了也可以）
    progress(sch.state)                           # 进度条数据（纯函数）
    text = sch.to_json()                          # 存盘

时间参数 now 用秒（Unix 时间戳即可）。
"""
from __future__ import annotations

import json
import math
import random
import zlib
from dataclasses import asdict, dataclass, fields
from typing import Iterable, Mapping, Optional, Sequence

GRADES = ("again", "hard", "good", "easy")
SCHEMA_VERSION = 1
RECENT_KEEP = 8  # 最多记最近几局的答案（用于「至少隔几局」和「同作品间隔」）

SEGMENTS = (
    ("stable", "已稳定"),
    ("consolidating", "巩固中"),
    ("learning", "学习中"),
    ("unseen", "未出现"),
)


@dataclass(frozen=True)
class Params:
    relearn_gap: float = 2.0       # I0：刚学会（第一次没认出）或答错后，隔几局再考
    growth: float = 2.5            # g：按时 Good 后，新间隔 = 实际间隔 × g
    hard_power: float = 0.5        # Hard 的倍数 = g ** hard_power（0.5 → √g ≈ 1.58；0 → 原地不动）
    overdue_cap: float = 6.25      # 逾期时最多按「计划间隔 × 这个数」记功（默认 g²，即最多多记两档）
    known_gap: float = 25.0        # 第一次出现就 Good（本来就认识）：隔几局再看
    known_gap_easy: float = 60.0   # 第一次出现就 Easy
    new_every: int = 4             # 还有没出现的角色时，每 new_every 局至少 1 个新角色；0 = 不保底
    work_gap: int = 3              # 最近 work_gap 局的答案涉及的作品，这局先不出；0 = 不管
    min_gap: int = 2               # 同一角色两次出现之间至少隔几局（题库太小时自动放宽）
    leech_fails: int = 0           # 连续几次 Again 后先停放；0 = 不停放（默认，难记的角色照常出现）
    park_gap: float = 40.0         # 停放后隔几局（比一次会话的局数多，相当于「下次再说」）
    jitter: float = 0.15           # 新间隔随机 ±15%，避免固定顺序被猜出来
    pause_min_sec: float = 180.0   # 两局之间空闲超过这么久，才把空闲时间折算成局数
    sec_per_game: float = 60.0     # 折算比例：每 60 秒空闲 = 1 局
    stable_gap: float = 10.0       # 进度：隔这么多局后仍 Good = 已稳定（题库小于 12 人时按 人数-2）
    long_break_sec: float = 6 * 3600.0  # 进度事件：隔这么久（真实时间）仍 Good = 「隔天仍记得」
    saturate_after: int = 3        # 连续几局都只能「提前复习」→ 提示本组暂时练到饱和

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[Mapping]) -> "Params":
        if not d:
            return cls()
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


ITEM_FIELDS = ("seen", "I", "last", "last_ts", "F", "fails", "proven", "lapses", "parked")


def blank_item() -> dict:
    """一个还没出现过的角色的状态。"""
    return {
        "seen": 0,        # 当答案出现过几次
        "I": 0.0,         # 目标间隔：下次至少隔几局再出
        "last": None,     # 上次出现时的虚拟局号
        "last_ts": None,  # 上次出现结束时的真实时间（秒）
        "F": None,        # 跌回前已证明过的间隔；重新学会后直接跳回这里
        "fails": 0,       # 连续 Again 次数
        "proven": 0.0,    # 自上次跌回以来，Good 过的最大间隔（局）；进度条用
        "lapses": 0,      # 累计 Again 次数（统计用）
        "parked": 0,      # 被停放过几次（统计用）
    }


def _core(item: Optional[Mapping]) -> dict:
    if not item:
        return blank_item()
    return {k: item.get(k, blank_item()[k]) for k in ITEM_FIELDS}


def _jitter(key: str, seen: int, p: Params) -> float:
    """确定性的随机因子（同一角色同一次复习永远一样，所以改评分时可以精确重算）。"""
    if p.jitter <= 0:
        return 1.0
    h = zlib.crc32(f"{key}#{seen}".encode("utf-8")) / 0xFFFFFFFF
    return 1.0 + p.jitter * (2.0 * h - 1.0)


def apply_grade(item: Mapping, grade: str, gap: Optional[float], p: Params, key: str) -> dict:
    """纯函数：一个角色得到评分后的新状态。

    item  : 评分前的状态（只读）
    grade : again / hard / good / easy
    gap   : 这次和上次之间隔了几局（虚拟局数，含中断折算）；第一次出现传 None
    返回新的状态 dict（不含 last / last_ts / prev / rev，由调用方补）。
    """
    if grade not in GRADES:
        raise ValueError(f"unknown grade: {grade!r}")
    it = _core(item)
    g = p.growth
    i0 = p.relearn_gap
    j = _jitter(key, it["seen"], p)

    if it["seen"] == 0 or gap is None:
        # 第一次出现：这一局本身是一次测验。
        if grade == "good":          # 本来就认识
            it["I"] = p.known_gap * j
            it["proven"] = p.known_gap
            it["fails"] = 0
        elif grade == "easy":
            it["I"] = p.known_gap_easy * j
            it["proven"] = p.known_gap_easy
            it["fails"] = 0
        else:                        # Hard / Again：不认识，靠推理或没猜出来；这一局等于学了一遍
            it["I"] = i0 * j
            it["proven"] = 0.0
            it["fails"] = 1 if grade == "again" else 0
            if grade == "again":
                it["lapses"] += 1
        it["F"] = None
    else:
        old_i = it["I"]
        on_time = gap >= old_i
        credit = min(gap, p.overdue_cap * old_i) if on_time else gap
        if grade == "again":
            it["F"] = it["proven"] if it["proven"] >= g * i0 else None
            it["proven"] = 0.0
            it["lapses"] += 1
            it["fails"] += 1
            if p.leech_fails and it["fails"] >= p.leech_fails:
                it["I"] = p.park_gap * j
                it["fails"] = 0
                it["parked"] += 1
                it["F"] = None
            else:
                it["I"] = i0 * j
        elif grade == "hard":
            it["fails"] = 0
            hm = g ** p.hard_power
            if on_time:
                it["I"] = max(i0, credit * hm * j)
            else:  # 提前复习还很吃力：间隔不升，适当往回收
                it["I"] = max(i0, min(old_i, gap * hm * j))
        else:  # good / easy
            it["fails"] = 0
            mult = g if grade == "good" else g * g
            if on_time:
                new_i = credit * mult * j
            else:  # 提前复习答对：只在证据足够时才加长，不会缩短
                new_i = max(old_i, gap * mult * j)
            if it["F"]:
                new_i = max(new_i, it["F"])
                it["F"] = None
            it["I"] = new_i
            it["proven"] = max(it["proven"], gap)
    it["seen"] += 1
    return it


def choose_next(state: Mapping, vt_now: float, p: Params,
                pool_set: Optional[set] = None) -> tuple[Optional[str], Optional[str]]:
    """纯函数：选下一局的答案。返回 (key, 选中原因)。

    原因：new_floor（新角色保底）/ due（到期复习）/ new（没有到期的，出新角色）/
          early（没有到期也没有新角色，提前复习最接近到期的）/ fallback（题库只有 1–2 人）
    """
    pool = state["pool"]
    n = len(pool)
    if n == 0:
        return None, None
    items = state["items"]
    groups = state.get("groups") or {}
    recent = state.get("recent") or []
    if pool_set is None:
        pool_set = set(pool)

    min_gap = max(0, min(p.min_gap, n - 1))
    blocked = set(recent[-min_gap:]) if min_gap > 0 else set()
    recent_works: set = set()
    if p.work_gap > 0:
        for k in recent[-p.work_gap:]:
            recent_works.update(groups.get(k, ()))

    if len(items) <= n:
        seen_keys = [k for k, it in items.items() if it["seen"] > 0 and k in pool_set]
    else:
        seen_keys = [k for k in pool if k in items and items[k]["seen"] > 0]
    new_queue = state.get("new_queue") or []

    def ok(k: str, strict: bool) -> bool:
        if k in blocked:
            return False
        if strict and recent_works and not recent_works.isdisjoint(groups.get(k, ())):
            return False
        return True

    for strict in ((True, False) if recent_works else (False,)):
        new_pick = next((k for k in new_queue if ok(k, strict)), None)
        if new_pick is not None and p.new_every > 0 and state["since_new"] >= p.new_every - 1:
            return new_pick, "new_floor"
        best, best_r = None, -1.0
        early, early_r = None, -1.0
        for k in seen_keys:
            if not ok(k, strict):
                continue
            it = items[k]
            gap = vt_now - it["last"] - 1.0
            r = (gap + 1.0) / (it["I"] + 1.0)   # 逾期比例：越大越该出
            if gap >= it["I"]:
                if r > best_r:
                    best, best_r = k, r
            elif r > early_r:
                early, early_r = k, r
        if best is not None:
            return best, "due"
        if new_pick is not None:
            return new_pick, "new"
        if early is not None:
            return early, "early"

    # 题库只有 1–2 人这类极端情况：放开「至少隔几局」
    if new_queue:
        return new_queue[0], "fallback"
    if seen_keys:
        k = max(seen_keys, key=lambda k: vt_now - items[k]["last"])
        return k, "fallback"
    return None, None


class Scheduler:
    """把状态 dict 包一层，提供开局 / 结束 / 改评分 / 换题库 / 存取。"""

    def __init__(self, state: dict):
        if state.get("version") != SCHEMA_VERSION:
            raise ValueError(f"unsupported state version: {state.get('version')!r}")
        self.state = state
        self.p = Params.from_dict(state.get("params"))
        self._pool_set = set(state["pool"])

    # ---------- 创建 / 存取 ----------
    @classmethod
    def new(cls, pool: Iterable, groups: Optional[Mapping[str, Sequence]] = None,
            params: Optional[Params] = None, shuffle_seed: Optional[int] = None) -> "Scheduler":
        p = params or Params()
        state = {
            "version": SCHEMA_VERSION,
            "params": p.to_dict(),
            "vt": -1.0,            # 虚拟局号：每局 +1，两局间的长空闲按时间折算后加上
            "games": 0,            # 真实局数
            "last_end_ts": None,
            "items": {},           # key -> 角色状态（只存出现过的）
            "pool": [],
            "groups": {},
            "new_queue": [],
            "recent": [],
            "since_new": p.new_every,
            "early_streak": 0,
            "current": None,
            "last_change": None,
        }
        sch = cls(state)
        sch.set_pool(pool, groups, shuffle_seed=shuffle_seed)
        return sch

    @classmethod
    def from_json(cls, text: str) -> "Scheduler":
        return cls(json.loads(text))

    def to_json(self) -> str:
        return json.dumps(self.state, ensure_ascii=False)

    def set_pool(self, pool: Iterable, groups: Optional[Mapping[str, Sequence]] = None,
                 shuffle_seed: Optional[int] = None) -> None:
        """换题库（或题库内容变了）。已有的角色进度保留，不在题库里的只是暂时不出。

        groups: key -> 该角色登场作品 id 列表（用于「同作品间隔」）。
        新角色的出场顺序 = pool 的顺序；给了 shuffle_seed 就按种子打乱。
        """
        st = self.state
        keys = list(dict.fromkeys(str(k) for k in pool))
        st["pool"] = keys
        self._pool_set = set(keys)
        if groups is not None:
            st["groups"] = {k: [str(w) for w in groups.get(k, ())] for k in keys}
        else:
            st["groups"] = {k: v for k, v in (st.get("groups") or {}).items() if k in self._pool_set}
        items = st["items"]
        queue = [k for k in keys if k not in items or items[k]["seen"] == 0]
        if shuffle_seed is not None:
            random.Random(shuffle_seed).shuffle(queue)
        st["new_queue"] = queue
        st["early_streak"] = 0
        if st.get("current") and st["current"]["key"] not in self._pool_set:
            st["current"] = None

    # ---------- 一局的生命周期 ----------
    def start_next(self, now: float) -> Optional[str]:
        """开新的一局：先把长空闲折算成局数，再选答案。没结束的上一局直接作废。"""
        st, p = self.state, self.p
        st["current"] = None
        bonus = 0.0
        if st["last_end_ts"] is not None:
            idle = now - st["last_end_ts"]
            if idle >= p.pause_min_sec:
                bonus = idle / p.sec_per_game
        vt_now = st["vt"] + 1.0 + bonus
        key, why = choose_next(st, vt_now, p, self._pool_set)
        if key is None:
            return None
        st["vt"] = vt_now
        st["current"] = {"key": key, "vt": vt_now, "start_ts": now, "why": why}
        st["early_streak"] = st["early_streak"] + 1 if why == "early" else 0
        return key

    def finish(self, grade: str, now: float) -> dict:
        """当前这一局结束，记录评分。返回该角色的新状态。"""
        st = self.state
        cur = st.get("current")
        if not cur:
            raise RuntimeError("没有进行中的一局")
        key = cur["key"]
        core = _core(st["items"].get(key))
        gap = None if core["seen"] == 0 else cur["vt"] - core["last"] - 1.0
        new = apply_grade(core, grade, gap, self.p, key)
        new["last"] = cur["vt"]
        new["last_ts"] = now
        new["prev"] = core
        new["rev"] = {"vt": cur["vt"], "gap": gap, "grade": grade, "ts": now, "why": cur["why"]}
        st["items"][key] = new
        if core["seen"] == 0:
            if key in st["new_queue"]:
                st["new_queue"].remove(key)
            st["since_new"] = 0
        else:
            st["since_new"] += 1
        st["recent"].append(key)
        del st["recent"][:-RECENT_KEEP]
        st["last_end_ts"] = now
        st["current"] = None
        st["games"] += 1
        st["last_change"] = {"key": key, "kind": "finish", "grade": grade}
        return new

    def regrade(self, key: str, grade: str, vt: Optional[float] = None) -> dict:
        """把某角色「最近一次」的评分改成 grade。

        做法：回到那次评分之前的快照，用同一个间隔重新算一遍。改几次都只算一次，
        不会重复累计 lapses / fails；下一局已经选好也没关系（那局照常进行）。
        vt：可选，传入要改的那一局的虚拟局号；如果这个角色在那之后又出现过，就报错。
        """
        st = self.state
        it = st["items"].get(key)
        if not it or not it.get("rev"):
            raise KeyError(f"{key} 还没有可改的评分")
        rev = it["rev"]
        if vt is not None and abs(rev["vt"] - vt) > 1e-9:
            raise ValueError("这个角色之后又出现过，不能再改那一局")
        base = it["prev"]
        new = apply_grade(base, grade, rev["gap"], self.p, key)
        new["last"] = rev["vt"]
        new["last_ts"] = rev["ts"]
        new["prev"] = base
        new["rev"] = dict(rev, grade=grade)
        st["items"][key] = new
        st["last_change"] = {"key": key, "kind": "regrade", "grade": grade, "old_grade": rev["grade"]}
        return new


# ---------------------------------------------------------------- 进度条

def stable_threshold(pool_size: int, p: Params) -> float:
    """「已稳定」需要的间隔（局）。题库太小时间隔拉不长，按 人数-2 封顶。"""
    return max(1.0, min(p.stable_gap, pool_size - 2.0))


def mastery(item: Optional[Mapping], threshold: float) -> float:
    """单个角色的巩固程度 0..1 = 自上次跌回以来 Good 过的最大间隔 / 稳定线。"""
    if not item or item.get("seen", 0) == 0:
        return 0.0
    return min(1.0, float(item.get("proven", 0.0)) / threshold)


def segment_of(item: Optional[Mapping], m: float) -> str:
    if not item or item.get("seen", 0) == 0:
        return "unseen"
    if m >= 1.0:
        return "stable"
    if m > 0.0:
        return "consolidating"
    return "learning"


_EVENT_LABEL = {
    "new_character": "新角色登场",
    "known_on_sight": "一眼认出",
    "level_up": "巩固升级",
    "became_stable": "首次稳定",
    "lapse": "跌回学习中",
    "miss": "没猜出",
    "parked": "先放一放（连续答错）",
    "recalled_after_break": "隔了很久仍记得",
    "all_stable": "本组全部稳定",
    "saturated": "本组暂时练到饱和",
    "regraded": "评分已更正",
}


def progress(state: Mapping) -> dict:
    """纯函数：当前题库的进度。

    total    : 0–100，= 题库里每个角色巩固程度的平均值 × 100（未出现的角色算 0）
    segments : 四段人数（已稳定 / 巩固中 / 学习中 / 未出现）
    parts    : 每段对 total 的贡献百分比 = 该段角色的巩固度之和 ÷ 题库人数 × 100（未出现恒为 0）；
               四段相加 ≈ total（各自四舍五入到 2 位，可能差 0.01），进度条用它画分段颜色
    events   : 最近一次结束（或改评分）带来的事件，给动画用
    saturated: 连续几局都只能提前复习 → 可以提示「本组暂时练到饱和」
    """
    p = Params.from_dict(state.get("params"))
    pool = state["pool"]
    n = len(pool)
    items = state["items"]
    th = stable_threshold(n, p)
    counts = {sid: 0 for sid, _ in SEGMENTS}
    sums = {sid: 0.0 for sid, _ in SEGMENTS}
    total = 0.0
    for k in pool:
        it = items.get(k)
        m = mastery(it, th)
        seg = segment_of(it, m)
        counts[seg] += 1
        sums[seg] += m
        total += m
    pct = 100.0 * total / n if n else 0.0
    saturated = state.get("early_streak", 0) >= p.saturate_after
    return {
        "total": round(pct, 2),
        "segments": [{"id": sid, "label": label, "count": counts[sid]} for sid, label in SEGMENTS],
        "parts": [{"id": sid, "label": label, "pct": round(100.0 * sums[sid] / n, 2) if n else 0.0}
                  for sid, label in SEGMENTS],
        "stable_gap": th,
        "saturated": saturated,
        "events": _events(state, p, th, counts, n),
    }


def _events(state: Mapping, p: Params, th: float, counts: Mapping, n: int) -> list:
    lc = state.get("last_change")
    if not lc:
        return []
    key = lc["key"]
    after = state["items"].get(key)
    if not after or "prev" not in after:
        return []
    before = after["prev"]
    grade = lc["grade"]
    first = before.get("seen", 0) == 0
    regrade = lc["kind"] == "regrade"
    if regrade:
        # 改评分：和「改之前屏幕上显示的状态」（按旧评分算出的结果）比，而不是和这局之前比
        shown = apply_grade(before, lc["old_grade"], after.get("rev", {}).get("gap"), p, key)
    else:
        shown = before
    m0, m1 = mastery(shown, th), mastery(after, th)
    s0, s1 = segment_of(shown, m0), segment_of(after, m1)
    in_pool = key in set(state["pool"]) if n else False
    common = {
        "key": key, "grade": grade, "from": s0, "to": s1,
        "mastery_from": round(m0, 3), "mastery_to": round(m1, 3),
        "delta_total": round(100.0 * (m1 - m0) / n, 3) if (n and in_pool) else 0.0,
    }
    types = []
    if regrade:
        types.append("regraded")
        if first and grade in ("good", "easy") and lc["old_grade"] not in ("good", "easy"):
            types.append("known_on_sight")
        if m0 < 1.0 <= m1:
            types.append("became_stable")
            if in_pool and counts["stable"] == n:
                types.append("all_stable")
        out = []
        for t in types:
            e = dict(common, type=t, label=_EVENT_LABEL[t])
            if t == "regraded":
                e["old_grade"] = lc.get("old_grade")
            out.append(e)
        return out
    if first:
        types.append("new_character")
        if grade in ("good", "easy"):
            types.append("known_on_sight")
    if m1 > m0 and not first:
        types.append("level_up")
    if m0 < 1.0 <= m1:
        types.append("became_stable")
    if grade == "again":
        types.append("lapse" if m0 > 0 else "miss")
    if after.get("parked", 0) > before.get("parked", 0):
        types.append("parked")
    if (grade in ("good", "easy") and not first and before.get("last_ts") is not None
            and after["last_ts"] - before["last_ts"] >= p.long_break_sec):
        types.append("recalled_after_break")
    if in_pool and m0 < 1.0 <= m1 and counts["stable"] == n:
        types.append("all_stable")
    if lc["kind"] == "finish" and state.get("early_streak", 0) == p.saturate_after:
        types.append("saturated")
    out = []
    for t in types:
        e = dict(common, type=t, label=_EVENT_LABEL[t])
        if t == "regraded":
            e["old_grade"] = lc.get("old_grade")
        out.append(e)
    return out
