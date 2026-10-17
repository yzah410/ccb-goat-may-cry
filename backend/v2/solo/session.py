# -*- coding: utf-8 -*-
"""单人版「猜猜呗」的对局逻辑：会话、一局状态、评级判定、宽免判定、进度存储、日志。

接口说明见 solo/README.md「对局接口」一节。
HTTP 层在 session_router.py；这里只管逻辑，不依赖 FastAPI。

名词：
- 会话（Session）：前端打开练习页时建一个，存内存（最多 8 个）。带着方案求出的题库、每个人的「作品」。
- 一局（Round）：开局时调度器选出答案；之后每次猜测或超时都是一「行」（从 1 开始编号）；猜中、投降时结束。
- 调度器（scheduler.py）按「模式 + 练法」各存一份进度，所有方案共用，落在 data/solo_v2/。

一局的规则（详见 solo/README.md「一局的规则」）：
- 猜中：practice=work 时，猜的角色就是答案，或者在「答案的作品」里登场过；practice=char 时只有答案本人。
- 没猜中（miss）：猜错、或超时。猜错时满足全部宽免条件就记为「宽免」，不计入 Again。
- 计入次数 = miss 数 − 宽免数，达到 3 → 这一局记 Again（之后不再变，但这一局继续，可以猜到猜中或投降）。
- 自动评级：Again 锁定 → again；第 1、2 行猜中 → good；第 k（≥ 3）行猜中 → 第 2→3 … (k−1)→k 行的
  间隔取平均，≤ 分界线 → good，否则 hard。自动评级永远不给 easy（只能手动改）。
  分界线 = good_sec + work_bonus_sec × （结束行是「搜作品选的」的间隔数）/（间隔总数）。
  每次猜测带 via："name"（按名字搜到的，默认）或 "work"（搜作品后从作品的角色列表里选的，打字 + 翻列表更费时间，所以加时）。
  超时行没有 via，也没有加时。
- 投降 → again。

线程安全：所有会改状态的操作都在 `SoloService._lock` 里。会读库的操作先读完、再改状态
（库在读的过程中被换掉时 with_snapshot 会整个重跑，所以「读」不能夹在「改」的后面）。
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .. import engine, settings
from ..router import _add_has_anime
from ..store import C_NAME, HUB
from .feedback import SoloError, char_names, check_tag_num, comments_map, extra_apps, solo_feedback
from .scheduler import GRADES, Params, Scheduler, progress

PRACTICES = ("work", "char")
MAX_SESSIONS = 8
AGAIN_AT = 3                    # 计入次数达到这个数 → 本局记 Again
FORGIVE_MAX = 2                 # 一局最多宽免几次
TIMEOUT_SLACK = 1.5             # 超时接口：距上一行不到「时间限制 − 这么多秒」就算误触发
DEFAULT_GOOD_SEC = 10.0
DEFAULT_WORK_BONUS_SEC = 2.0    # 结束行是「搜作品选的」的间隔，分界线多给这么多秒
VIAS = ("name", "work")         # 一次猜测是怎么选出来的：按名字搜 / 搜作品后从作品的角色列表里选
FB_STRIP = ("answer_id", "correct")   # 反馈里去掉这两个键：不泄露答案，也是「区分不了」比较时忽略的键
WRONG_WORKS_MAX = 50            # 结算块里每个猜错的角色最多带几个登场作品 id（导图联动用）

# 调度器给的选中原因 → 结算时显示的中文
WHY_LABEL = {
    "new_floor": "新角色保底",
    "due": "到期复习",
    "new": "新角色",
    "early": "提前复习",
    "fallback": "题库很小，放宽了间隔",
}


# ---------------------------------------------------------------- 参数检查
def check_practice(v: Any) -> str:
    if v not in PRACTICES:
        raise SoloError(422, "bad_practice", "练法只能是 work（猜中作品算猜对）或 char（必须猜中角色本人）")
    return v


def check_new_every(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 20:
        raise SoloError(422, "bad_new_every", "新角色保底（new_every）要是 0 到 20 的整数")
    return v


def _number(v: Any, lo: float, hi: float, code: str, label: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not lo <= v <= hi:
        raise SoloError(422, code, f"{label}要是 {lo:g} 到 {hi:g} 之间的数")
    return v


def check_good_sec(v: Any) -> float:
    return _number(DEFAULT_GOOD_SEC if v is None else v, 1, 120, "bad_good_sec", "Good 分界秒数")


def check_time_limit(v: Any) -> Optional[float]:
    return None if v is None else _number(v, 1, 60, "bad_time_limit", "时间限制")


def check_work_bonus_sec(v: Any) -> float:
    return _number(DEFAULT_WORK_BONUS_SEC if v is None else v, 0, 10, "bad_work_bonus_sec", "作品加时秒数")


def check_via(v: Any) -> str:
    """None = "name"；其他只认 "name" / "work"。"""
    if v is None:
        return "name"
    if not isinstance(v, str) or v not in VIAS:
        raise SoloError(422, "bad_via", "via 只能是 name（按名字搜）或 work（搜作品后选角色），或不传")
    return v


# ---------------------------------------------------------------- 纯函数：计时、评级、宽免
def strip_feedback(fb: Dict[str, Any]) -> Dict[str, Any]:
    """去掉 answer_id / correct。结果可以安全地发给前端，也是「区分不了」的比较对象。"""
    return {k: v for k, v in fb.items() if k not in FB_STRIP}


def interval_secs(times: Sequence[float], last: Optional[int] = None) -> List[Tuple[int, int, float]]:
    """times：按行号排好的各行时间戳（第 1 行在下标 0）。返回 [(from, to, 秒)]：第 2→3、3→4、…行的时间差。
    计时从第 2 行开始（打字要时间）；超时行也是计时点。last：只算到第几行（默认全部）。"""
    n = len(times) if last is None else min(last, len(times))
    return [(i, i + 1, times[i] - times[i - 1]) for i in range(2, n)]


def _end_via(vias: Optional[Sequence[Optional[str]]], seq: int) -> Optional[str]:
    """第 seq 行（从 1 起）的来源；没给 vias、或那一行是超时行（None）→ None。"""
    return vias[seq - 1] if vias is not None and 0 < seq <= len(vias) else None


def threshold_sec(ivs: Sequence[Tuple[int, int, float]], vias: Optional[Sequence[Optional[str]]], good_sec: float,
                  work_bonus_sec: float) -> float:
    """实际用的分界线 = good_sec + work_bonus_sec × （结束行 via == "work" 的间隔数）/（间隔总数）。
    等价于：每个间隔先减掉自己的加时，再取平均，和 good_sec 比。没有间隔（第 1、2 行猜中）→ good_sec。"""
    if not ivs:
        return good_sec
    n_work = sum(1 for _a, b, _s in ivs if _end_via(vias, b) == "work")
    return good_sec + work_bonus_sec * n_work / len(ivs)


def timing_block(times: Sequence[float], good_sec: float, last: Optional[int] = None,
                 vias: Optional[Sequence[Optional[str]]] = None, work_bonus_sec: float = 0.0) -> Dict[str, Any]:
    """vias：和 times 一一对应的各行来源（超时行 None）；不给 = 都当没有加时。"""
    iv = interval_secs(times, last)
    return {"intervals": [{"from": a, "to": b, "sec": round(s, 3), "via": _end_via(vias, b),
                           "bonus_sec": work_bonus_sec if _end_via(vias, b) == "work" else 0}
                          for a, b, s in iv],
            "avg_sec": round(sum(s for _, _, s in iv) / len(iv), 3) if iv else None,
            "good_sec": good_sec, "work_bonus_sec": work_bonus_sec,
            "threshold_sec": round(threshold_sec(iv, vias, good_sec, work_bonus_sec), 3)}


def auto_grade(hit_seq: int, times: Sequence[float], good_sec: float, again_locked: bool,
               vias: Optional[Sequence[Optional[str]]] = None, work_bonus_sec: float = 0.0) -> str:
    """猜中那一行是 hit_seq 时的自动评级（永远不给 easy）。"""
    if again_locked:
        return "again"
    if hit_seq <= 2:
        return "good"                                   # 还没开始计时
    iv = interval_secs(times, hit_seq)
    avg = sum(s for _, _, s in iv) / len(iv)
    return "good" if avg <= threshold_sec(iv, vias, good_sec, work_bonus_sec) + 1e-9 else "hard"


def is_forgiven(is_guess: bool, in_pool: bool, earlier_guesses: int, forgiven: int, again_locked: bool,
                indistinguishable: Callable[[], bool]) -> bool:
    """一次 miss 能不能宽免。六条要同时满足：
    1 是猜测行（超时不宽免）；2 猜的角色在本会话题库里；3 这一行之前至少有 1 个猜测行（第一次猜测什么信息都没亮，
    谁都区分不了，所以不宽免）；4 本局已宽免次数 < 2；5 本局还没被判 Again；6 区分不了（最后判，因为最贵）。"""
    if not is_guess or not in_pool or earlier_guesses < 1:
        return False
    if forgiven >= FORGIVE_MAX or again_locked:
        return False
    return bool(indistinguishable())


# ---------------------------------------------------------------- 一行 / 一局 / 会话
@dataclass
class Row:
    seq: int
    kind: str                                # "guess" | "timeout"
    t: float                                 # 后端时间戳
    guess_id: Optional[int] = None
    name: Optional[str] = None
    name_original: Optional[str] = None      # character.name（日文原名）：名字格上行
    name_cn: Optional[str] = None            # character.name_cn：名字格下行，库里没有就是 None
    feedback: Optional[Dict[str, Any]] = None   # 已去掉 answer_id / correct
    hit: bool = False
    exact: bool = False
    forgiven: bool = False
    via: Optional[str] = None                # "name" | "work"；超时行 None

    def public(self, start_ts: float) -> Dict[str, Any]:
        out: Dict[str, Any] = {"seq": self.seq, "kind": self.kind, "t_offset": round(self.t - start_ts, 3)}
        if self.kind == "guess":
            out.update({"guess_id": self.guess_id, "name": self.name, "name_original": self.name_original,
                        "name_cn": self.name_cn, "feedback": self.feedback,
                        "hit": self.hit, "exact": self.exact, "forgiven": self.forgiven, "via": self.via})
        else:
            out.update({"hit": False, "forgiven": False, "via": None})
        return out


@dataclass
class Round:
    id: str
    no: int
    answer_id: int
    key: str
    bound: Optional[int]                     # 答案的作品（best_bound_work）
    work_members: frozenset                  # 在答案的作品里登场过的角色 id（任何关系）
    subject_tag_num: int
    character_tag_num: int
    good_sec: float
    time_limit_sec: Optional[float]
    start_ts: float
    vt: float
    why: str
    gap_rounds: Optional[float]
    gap_sec: Optional[float]
    prev_grade: Optional[str]
    rows: List[Row] = field(default_factory=list)
    misses: int = 0
    forgiven: int = 0
    again_locked: bool = False
    ended: bool = False
    work_bonus_sec: float = DEFAULT_WORK_BONUS_SEC

    @property
    def counted(self) -> int:
        return self.misses - self.forgiven

    def status(self) -> Dict[str, Any]:
        return {"rows": len(self.rows), "misses": self.misses, "forgiven": self.forgiven, "counted": self.counted,
                "again_locked": self.again_locked, "limit": AGAIN_AT + self.forgiven}

    def count_miss(self, forgiven: bool) -> None:
        self.misses += 1
        if forgiven:
            self.forgiven += 1
        if self.counted >= AGAIN_AT:
            self.again_locked = True


@dataclass
class EndedRound:
    """最近结束的一局（只有它能改评级）。"""
    round_id: str
    key: str
    vt: float
    char_id: int
    grade_auto: str
    grade: str


@dataclass
class Session:
    id: str
    mode: str
    practice: str
    plan_name: Optional[str]
    spec: Any
    ev: Any
    pool_ids: List[int]
    pool_set: frozenset
    pool_keys: List[str]
    groups: Dict[str, List[str]]
    bound: Dict[int, Optional[int]]
    default_tag_num: int
    progress_at_start: float
    round: Optional[Round] = None
    last_ended: Optional[EndedRound] = None


@dataclass
class Entry:
    """一个 (mode, practice) 的调度器 + 种子。同一个 (mode, practice) 只有一份，所有会话共用。"""
    mode: str
    practice: str
    seed: int
    sch: Scheduler
    owner: Optional[str] = None              # 调度器当前的题库是哪个会话设的
    notes: List[str] = field(default_factory=list)   # 载入时的提示（比如进度文件损坏）


def char_key(cid: int) -> str:
    return f"char:{cid}"


def key_cid(key: str) -> int:
    return int(key.split(":", 1)[1])


def pool_with_works(snap: Any, spec: Any) -> Tuple[Any, List[int], Dict[int, Optional[int]], Dict[int, List[int]]]:
    """方案 → (求值结果, 题库角色 id 升序, 每人的绑定作品, 每人的作品 id 列表)。
    作品列表 = [绑定作品] + 该角色在当前模式下的全部登场作品，去重，绑定作品在前——调度器的分组和导图联动的预选都用它。
    题库为空 → SoloError 422 empty_pool。"""
    ev = engine.evaluate(spec)
    pool = [c for c in ev.pool_sorted if c in snap.C]
    if not pool:
        raise SoloError(422, "empty_pool", "这个方案的题库是空的，没有题可出。先去工作台把范围调出来")
    apps = ev.mp.apps
    bound: Dict[int, Optional[int]] = {}
    works: Dict[int, List[int]] = {}
    for cid in pool:
        b = ev.best_bound_work(cid)
        bound[cid] = b
        works[cid] = list(dict.fromkeys(([b] if b is not None else []) + list(apps.get(cid, ()))))
    return ev, pool, bound, works


# ---------------------------------------------------------------- 落盘
def atomic_write_json(path: str, data: Any) -> None:
    """tmp + os.replace。Windows 上 os.replace 偶尔被杀软 / 同步盘占用，重试几次。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        for i in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if i == 4:
                    raise
                time.sleep(0.05)
    except BaseException:
        try:
            os.remove(tmp)                   # 写一半失败：删掉半截的 tmp，原文件原样不动
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- 服务
class SoloService:
    def __init__(self, clock: Callable[[], float] = time.time):
        self.clock = clock                   # 可注入：测试里换成假时钟，不用真 sleep
        self._lock = threading.RLock()
        self._sessions: "OrderedDict[str, Session]" = OrderedDict()
        self._entries: Dict[Tuple[str, str], Entry] = {}

    def reset(self) -> None:
        """丢掉内存里的会话和调度器缓存（测试用；磁盘上的文件不动）。"""
        with self._lock:
            self._sessions.clear()
            self._entries.clear()

    # ------------------------------------------------------------ 路径 / 存取
    @staticmethod
    def root() -> str:
        return os.path.join(settings.data_dir(), "solo_v2")

    def sched_path(self, mode: str, practice: str) -> str:
        return os.path.join(self.root(), f"sched_{mode}_{practice}.json")

    def log_path(self, mode: str, practice: str) -> str:
        return os.path.join(self.root(), f"log_{mode}_{practice}.jsonl")

    def _entry(self, mode: str, practice: str) -> Entry:
        e = self._entries.get((mode, practice))
        if e is not None:
            return e
        path = self.sched_path(mode, practice)
        notes: List[str] = []
        sch: Optional[Scheduler] = None
        seed = 0
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                sch = Scheduler(data["scheduler"])
                seed = int(data["seed"])
            except (ValueError, KeyError, TypeError, OSError) as ex:
                # 文件坏了：挪到一边留着（不删），从头开始，并告诉调用方
                sch = None
                bad = f"{path}.bad-{int(self.clock())}"
                try:
                    os.replace(path, bad)
                    notes.append(f"进度文件读不出来（{type(ex).__name__}），已另存为 {os.path.basename(bad)}，本组从头开始记")
                except OSError:
                    notes.append(f"进度文件读不出来（{type(ex).__name__}），本组从头开始记")
        if sch is None:
            sch = Scheduler.new([], None)
            seed = secrets.randbits(31)              # 第一次建：随机种子，存下来；新角色出场顺序因此固定
        e = Entry(mode=mode, practice=practice, seed=seed, sch=sch, notes=notes)
        self._entries[(mode, practice)] = e
        return e

    def _save(self, e: Entry) -> None:
        atomic_write_json(self.sched_path(e.mode, e.practice),
                          {"version": 1, "mode": e.mode, "practice": e.practice, "seed": e.seed,
                           "scheduler": e.sch.state})

    def _log(self, mode: str, practice: str, obj: Dict[str, Any]) -> None:
        path = self.log_path(mode, practice)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------ 会话
    def _get(self, session_id: Any) -> Session:
        s = self._sessions.get(session_id) if isinstance(session_id, str) else None
        if s is None:
            raise SoloError(404, "session_not_found", "对局会话已经失效（后端重启过？），请重新开始练习")
        self._sessions.move_to_end(session_id)
        return s

    def _ev_for(self, sess: Session, snap: Any) -> Any:
        """会话里存的求值结果挂在建会话时的快照上；库被换过就按当前快照重算一次。"""
        if sess.ev.snap is not snap:
            sess.ev = engine.evaluate(sess.spec)
        return sess.ev

    def _progress(self, sess: Session, e: Entry, events: bool = True) -> Dict[str, Any]:
        pr = progress(e.sch.state)
        pr["session_delta"] = round(pr["total"] - sess.progress_at_start, 2)
        if not events:
            pr["events"] = []                # 开局 / 建会话时不重放上一局的事件
        return pr

    def create_session(self, snap: Any, spec: Any, plan_name: Optional[str] = None, practice: str = "work",
                       new_every: Optional[int] = None) -> Dict[str, Any]:
        practice = check_practice(practice)
        new_every = check_new_every(new_every)
        mode = spec.game.mode
        ev, pool, bound, works = pool_with_works(snap, spec)
        groups: Dict[str, List[str]] = {char_key(cid): [str(w) for w in works[cid]] for cid in pool}
        keys = [char_key(c) for c in pool]
        # 预热：第一次猜测要用的几张懒加载表（吐槽数、特殊游戏、角色标签、声优）在建会话时一起读好，
        # 省得第一次猜测卡大半秒。放在拿锁之前：读库的活不要占着锁。
        comments_map(snap)
        extra_apps(snap, mode)
        snap.char_tags()
        snap.vas()
        sid = uuid.uuid4().hex
        with self._lock:
            e = self._entry(mode, practice)
            sch = e.sch
            if new_every is not None:
                params = dict(sch.state.get("params") or sch.p.to_dict())
                params["new_every"] = new_every
                sch.state["params"] = params
                sch.p = Params.from_dict(params)
            cur = sch.state.get("current")
            if cur and cur["key"] not in set(keys):
                self._log_void(e, cur, rows=None)            # set_pool 会清掉它，先记一笔
            sch.set_pool(keys, groups, shuffle_seed=e.seed)
            e.owner = sid
            self._save(e)
            sess = Session(id=sid, mode=mode, practice=practice, plan_name=plan_name, spec=spec, ev=ev, pool_ids=pool,
                           pool_set=frozenset(pool), pool_keys=keys, groups=groups, bound=bound,
                           default_tag_num=spec.game.tag_count, progress_at_start=progress(sch.state)["total"])
            self._sessions[sid] = sess
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)           # 最久没用的会话丢掉
            notes, e.notes = e.notes, []
            return {"session_id": sid, "mode": mode, "practice": practice, "plan_name": plan_name,
                    "pool_total": len(pool), "pool_ids": pool, "default_subject_tag_num": sess.default_tag_num,
                    "new_every": sch.p.new_every, "errors": ev.errors, "warnings": list(ev.warnings) + notes,
                    "progress": self._progress(sess, e, events=False)}

    # ------------------------------------------------------------ 一局：开局
    def _log_void(self, e: Entry, cur: Dict[str, Any], rows: Optional[int]) -> None:
        self._log(e.mode, e.practice, {"ts": round(self.clock(), 3), "kind": "void", "char_id": key_cid(cur["key"]),
                                       "round_id": cur.get("round_id"), "rows": rows})

    def start_round(self, snap: Any, session_id: Any, subject_tag_num: Any = None, character_tag_num: Any = 0,
                    good_sec: Any = None, time_limit_sec: Any = None, work_bonus_sec: Any = None) -> Dict[str, Any]:
        with self._lock:
            sess = self._get(session_id)
            n = check_tag_num(sess.default_tag_num if subject_tag_num is None else subject_tag_num, "作品标签数")
            ctn = check_tag_num(0 if character_tag_num is None else character_tag_num, "角色标签数")
            good_sec = check_good_sec(good_sec)
            time_limit_sec = check_time_limit(time_limit_sec)
            work_bonus_sec = check_work_bonus_sec(work_bonus_sec)
            e = self._entry(sess.mode, sess.practice)
            sch = e.sch
            now = self.clock()
            # 这里没有读库的步骤（snap.s_apps 在内存里），所以可以放心改状态
            cur = sch.state.get("current")
            if cur:                                          # 上一局没打完：作废（本会话的、别的会话的、上次后端退出时留下的）
                own = sess.round if (sess.round and sess.round.id == cur.get("round_id")) else None
                self._log_void(e, cur, rows=len(own.rows) if own else None)
                sch.state["current"] = None
            if sess.round is not None:
                sess.round.ended = True                      # 本会话的旧局不管调度器里还在不在，都不能再猜了
            if e.owner != sess.id:                           # 调度器的题库被别的会话改过：换回本会话的
                sch.set_pool(sess.pool_keys, sess.groups, shuffle_seed=e.seed)
                e.owner = sess.id
            key = sch.start_next(now)
            if key is None:
                self._save(e)
                return {"round_id": None, "reason": "all_parked", "progress": self._progress(sess, e, events=False)}
            cur = sch.state["current"]
            cid = key_cid(key)
            bound = sess.bound.get(cid)
            members = frozenset(c for c, _rc, _o in snap.s_apps.get(bound, ())) if bound is not None else frozenset()
            item = sch.state["items"].get(key)
            seen = bool(item) and item.get("seen", 0) > 0 and item.get("last") is not None
            rid = uuid.uuid4().hex[:12]
            cur["round_id"] = rid
            rnd = Round(
                id=rid, no=sch.state["games"] + 1, answer_id=cid, key=key, bound=bound, work_members=members,
                subject_tag_num=n, character_tag_num=ctn, good_sec=good_sec, time_limit_sec=time_limit_sec,
                work_bonus_sec=work_bonus_sec, start_ts=now, vt=cur["vt"], why=cur["why"],
                gap_rounds=round(cur["vt"] - item["last"] - 1.0, 1) if seen else None,
                gap_sec=round(now - item["last_ts"], 1) if seen and item.get("last_ts") is not None else None,
                prev_grade=(item.get("rev") or {}).get("grade") if seen else None)
            sess.round = rnd
            self._save(e)
            return {"round_id": rid, "round_no": rnd.no, "subject_tag_num": n, "character_tag_num": ctn,
                    "good_sec": good_sec, "work_bonus_sec": work_bonus_sec, "time_limit_sec": time_limit_sec,
                    "status": rnd.status(), "progress": self._progress(sess, e, events=False)}

    def _active(self, sess: Session, round_id: Any) -> Tuple[Round, Entry]:
        """round_id 必须是本会话正在进行的这一局，而且调度器里还认它（没被别的会话作废）。"""
        rnd = sess.round
        if rnd is None or rnd.ended or rnd.id != round_id:
            raise SoloError(409, "round_not_active", "这一局已经结束或不存在了")
        e = self._entry(sess.mode, sess.practice)
        cur = e.sch.state.get("current")
        if not cur or cur.get("round_id") != rnd.id:
            rnd.ended = True
            raise SoloError(409, "round_not_active", "这一局已被作废（在别处开了新的一局）")
        return rnd, e

    # ------------------------------------------------------------ 一局：猜测
    def guess(self, snap: Any, session_id: Any, round_id: Any, guess_id: int, via: Any = None) -> Dict[str, Any]:
        with self._lock:
            sess = self._get(session_id)
            rnd, e = self._active(sess, round_id)
            via = check_via(via)
            if guess_id not in snap.C:
                raise SoloError(404, "not_found", "这个角色不在角色库里")
            # 同一个角色可以重复猜：和别的猜测一样加一行、记 miss、计入次数，宽免条件相同。
            # 重复猜的人在自己那一行上的反馈全是「对」，和答案的不全一样，所以过不了「区分不了」，不会被宽免。
            mp = HUB.mode(snap, sess.mode)
            n, ctn = rnd.subject_tag_num, rnd.character_tag_num

            def fb(g: int, a: int) -> Dict[str, Any]:
                return strip_feedback(solo_feedback(snap, sess.mode, g, a, n, ctn, mp=mp))

            # ---- 全部读完再改状态
            feedback = fb(guess_id, rnd.answer_id)
            exact = guess_id == rnd.answer_id
            by_work = (not exact) and sess.practice == "work" and guess_id in rnd.work_members
            hit = exact or by_work
            now = self.clock()
            orig, cn = char_names(snap, [guess_id]).get(guess_id, (None, None))
            row = Row(seq=len(rnd.rows) + 1, kind="guess", t=now, guess_id=guess_id, name=snap.C[guess_id][C_NAME],
                      name_original=orig, name_cn=cn, feedback=feedback, hit=hit, exact=exact, via=via)
            if not hit:
                earlier = [r for r in rnd.rows if r.kind == "guess"]

                def indistinguishable() -> bool:
                    # 假设猜的角色（guess_id）就是答案：对这一行之前的每个猜测，重算反馈表，
                    # 每一格都和真实答案的一样，才算「区分不了」
                    return all(fb(r.guess_id, guess_id) == r.feedback for r in earlier)

                row.forgiven = is_forgiven(True, guess_id in sess.pool_set, len(earlier), rnd.forgiven,
                                           rnd.again_locked, indistinguishable)
            prep = self._prepare_end(snap, sess, rnd) if hit else None
            # ---- 改状态
            rnd.rows.append(row)
            if not hit:
                rnd.count_miss(row.forgiven)
            end = self._end_round(sess, e, rnd, "exact" if exact else "work", prep, now) if hit else None
            return {"row": row.public(rnd.start_ts), "status": rnd.status(), "end": end}

    # ------------------------------------------------------------ 一局：超时
    def timeout(self, session_id: Any, round_id: Any) -> Dict[str, Any]:
        with self._lock:
            sess = self._get(session_id)
            rnd, _e = self._active(sess, round_id)
            if rnd.time_limit_sec is None:
                raise SoloError(409, "no_time_limit", "这一局没有设时间限制")
            now = self.clock()
            last_t = rnd.rows[-1].t if rnd.rows else rnd.start_ts
            if now - last_t < rnd.time_limit_sec - TIMEOUT_SLACK:
                raise SoloError(409, "too_early", "还没到时间限制")
            row = Row(seq=len(rnd.rows) + 1, kind="timeout", t=now)
            rnd.rows.append(row)
            rnd.count_miss(False)            # 超时算 miss、算计时点，不宽免
            return {"row": row.public(rnd.start_ts), "status": rnd.status(), "end": None}

    # ------------------------------------------------------------ 一局：投降
    def surrender(self, snap: Any, session_id: Any, round_id: Any) -> Dict[str, Any]:
        with self._lock:
            sess = self._get(session_id)
            rnd, e = self._active(sess, round_id)
            prep = self._prepare_end(snap, sess, rnd)
            return {"end": self._end_round(sess, e, rnd, "surrender", prep, self.clock())}

    # ------------------------------------------------------------ 一局：结束
    def _prepare_end(self, snap: Any, sess: Session, rnd: Round) -> Dict[str, Any]:
        """结算要读库的部分（卡片、答案名字）。必须在改任何状态之前做。"""
        ev = self._ev_for(sess, snap)
        card = engine.build_item(ev, rnd.answer_id, bound_sid=rnd.bound, use_bound=True)
        _add_has_anime(ev.snap, [card])
        orig, cn = char_names(snap, [rnd.answer_id]).get(rnd.answer_id, (None, None))
        # 导图联动：答案登场过的全部作品（绑定作品在前）、这一局猜错的人（按角色去重）和他们的登场作品
        mp = HUB.mode(snap, sess.mode)
        wrong: List[Dict[str, Any]] = []
        seen_wrong = set()
        for r in rnd.rows:
            if r.kind != "guess" or r.hit or r.guess_id in seen_wrong:
                continue
            seen_wrong.add(r.guess_id)
            wrong.append({"char_id": r.guess_id, "name": r.name,
                          "work_ids": list(mp.apps.get(r.guess_id, ()))[:WRONG_WORKS_MAX]})
        return {"card": card, "answer_name": snap.C[rnd.answer_id][C_NAME], "name_original": orig, "name_cn": cn,
                "answer_work_ids": [int(w) for w in sess.groups.get(rnd.key, ())], "bound_work_id": rnd.bound,
                "wrong_guesses": wrong}

    def _end_round(self, sess: Session, e: Entry, rnd: Round, ended_by: str, prep: Dict[str, Any],
                   now: float) -> Dict[str, Any]:
        times = [r.t for r in rnd.rows]
        vias = [r.via for r in rnd.rows]                    # 超时行是 None
        hit_seq = None if ended_by == "surrender" else rnd.rows[-1].seq
        grade_auto = ("again" if ended_by == "surrender"
                      else auto_grade(hit_seq, times, rnd.good_sec, rnd.again_locked, vias, rnd.work_bonus_sec))
        sch = e.sch
        sch.finish(grade_auto, now)
        item = sch.state["items"][rnd.key]
        next_gap = round(item["I"], 2)
        rnd.ended = True
        sess.last_ended = EndedRound(round_id=rnd.id, key=rnd.key, vt=rnd.vt, char_id=rnd.answer_id,
                                     grade_auto=grade_auto, grade=grade_auto)
        self._save(e)
        timing = timing_block(times, rnd.good_sec, vias=vias, work_bonus_sec=rnd.work_bonus_sec)
        timeouts = sum(1 for r in rnd.rows if r.kind == "timeout")
        self._log(sess.mode, sess.practice, {
            "ts": round(now, 3), "kind": "round", "round_id": rnd.id, "plan": sess.plan_name, "mode": sess.mode,
            "practice": sess.practice, "char_id": rnd.answer_id, "name": prep["answer_name"], "why": rnd.why,
            "vt": round(rnd.vt, 3), "gap_rounds": rnd.gap_rounds, "gap_sec": rnd.gap_sec, "prev_grade": rnd.prev_grade,
            "grade_auto": grade_auto, "grade": grade_auto, "ended_by": ended_by, "again_locked": rnd.again_locked,
            "rows": len(rnd.rows), "misses": rnd.misses, "forgiven": rnd.forgiven, "timeouts": timeouts,
            "hit_seq": hit_seq, "intervals": [x["sec"] for x in timing["intervals"]], "avg_sec": timing["avg_sec"],
            "good_sec": rnd.good_sec, "work_bonus_sec": rnd.work_bonus_sec, "threshold_sec": timing["threshold_sec"],
            "vias": vias, "duration_sec": round(now - rnd.start_ts, 3),
            "subject_tag_num": rnd.subject_tag_num, "character_tag_num": rnd.character_tag_num,
            "time_limit_sec": rnd.time_limit_sec, "next_gap": next_gap})
        return {
            "round_id": rnd.id, "answer_id": rnd.answer_id, "answer_name": prep["answer_name"],
            "name_original": prep["name_original"], "name_cn": prep["name_cn"], "card": prep["card"],
            "answer_work_ids": prep["answer_work_ids"], "bound_work_id": prep["bound_work_id"],
            "wrong_guesses": prep["wrong_guesses"],
            "grade_auto": grade_auto, "grade": grade_auto, "ended_by": ended_by, "again_locked": rnd.again_locked,
            "hit_seq": hit_seq, "rows": len(rnd.rows), "misses": rnd.misses, "forgiven": rnd.forgiven,
            "timing": timing, "why": rnd.why, "why_label": WHY_LABEL.get(rnd.why, rnd.why),
            "gap_rounds": rnd.gap_rounds, "gap_sec": rnd.gap_sec, "prev_grade": rnd.prev_grade,
            "next_gap": next_gap, "progress": self._progress(sess, e)}

    # ------------------------------------------------------------ 改评级
    def regrade(self, session_id: Any, round_id: Any, grade: Any) -> Dict[str, Any]:
        if grade not in GRADES:
            raise SoloError(422, "bad_grade", "评级只能是 easy / good / hard / again")
        with self._lock:
            sess = self._get(session_id)
            last = sess.last_ended
            if last is None or last.round_id != round_id:
                raise SoloError(409, "not_last_round", "只能改最近结束的那一局")
            e = self._entry(sess.mode, sess.practice)
            sch = e.sch
            if grade == last.grade:                          # 没变：不动调度器，不写日志，也不重放事件
                item = sch.state["items"].get(last.key)
                return {"round_id": round_id, "grade": grade, "grade_auto": last.grade_auto,
                        "next_gap": round(item["I"], 2) if item else None,
                        "progress": self._progress(sess, e, events=False)}
            try:
                sch.regrade(last.key, grade, last.vt)
            except ValueError:
                raise SoloError(409, "char_reappeared", "这个角色之后又出现过，不能再改那一局了")
            except KeyError:
                raise SoloError(409, "not_last_round", "只能改最近结束的那一局")
            old = last.grade
            last.grade = grade
            next_gap = round(sch.state["items"][last.key]["I"], 2)
            self._save(e)
            self._log(sess.mode, sess.practice, {"ts": round(self.clock(), 3), "kind": "regrade",
                                                 "char_id": last.char_id, "round_id": round_id, "old_grade": old,
                                                 "grade": grade, "next_gap": next_gap})
            return {"round_id": round_id, "grade": grade, "grade_auto": last.grade_auto, "next_gap": next_gap,
                    "progress": self._progress(sess, e)}


SOLO = SoloService()
